"""The Dial Self-Hosted AUDIO protocol as a Pipecat ``FrameSerializer``.

This is the whole adapter between Dial and Pipecat. Pipecat already knows how to
run a voice pipeline over a WebSocket; it just needs to be told what the frames
on that socket look like. A ``FrameSerializer`` answers exactly that, in two
directions, and Pipecat's ``FastAPIWebsocketTransport`` does the rest.

Dial -> Pipecat (``deserialize``):

- ``media``      -> ``InputAudioRawFrame`` (decoded to the pipeline's PCM rate)
- ``dtmf``       -> ``InputDTMFFrame``
- ``ping_pong``  -> the same frame, addressed back to Dial (see below)

Pipecat -> Dial (``serialize``):

- ``AudioRawFrame``     -> ``media`` (encoded to the negotiated outbound format)
- ``InterruptionFrame`` -> ``clear``  (barge-in: drop what Dial still has queued)
- ``EndFrame`` / ``CancelFrame`` -> ``end_call``

The keepalive is the one round trip that looks odd and isn't: Dial pings every
~2s and wants the identical frame back, but a serializer cannot write to the
socket itself. So ``deserialize`` returns the pong as an
``OutputTransportMessageUrgentFrame``, which travels down the pipeline to the
output transport and comes back through ``serialize``. This is the same pattern
Pipecat's own Genesys serializer uses.

Protocol reference: https://docs.getdial.ai/api-reference/self-hosted-audio-protocol
"""

from __future__ import annotations

import base64
import json

from loguru import logger
from pydantic import ValidationError

from pipecat.audio.dtmf.types import KeypadEntry
from pipecat.audio.resamplers.base_audio_resampler import BaseAudioResampler
from pipecat.audio.utils import (
    alaw_to_pcm,
    create_stream_resampler,
    pcm_to_alaw,
    pcm_to_ulaw,
    ulaw_to_pcm,
)
from pipecat.frames.frames import (
    AudioRawFrame,
    CancelFrame,
    EndFrame,
    Frame,
    InputAudioRawFrame,
    InputDTMFFrame,
    InterruptionFrame,
    OutputTransportMessageFrame,
    OutputTransportMessageUrgentFrame,
)
from pipecat.processors.frame_processor import FrameProcessorSetup
from pipecat.serializers.base_serializer import FrameSerializer

from dial_sdk import parse_dial_audio_message, serialize_server_audio_message
from dial_sdk.self_hosted_audio import (
    AudioFormat,
    AudioFormats,
    ServerAudioMedia,
    ServerClear,
    ServerEndCall,
    ServerMark,
)

# Every format Dial's audio mode speaks, and the sample rate it carries. Both
# directions are configured on your Self-Hosted config and arrive in
# `call_connected` — there is no in-band renegotiation.
FORMAT_SAMPLE_RATES: dict[AudioFormat, int] = {
    "mulaw_8000": 8000,
    "alaw_8000": 8000,
    "l16_8000": 8000,
    "l16_16000": 16000,
    "l16_24000": 24000,
}


def pipeline_sample_rates(formats: AudioFormats) -> tuple[int, int]:
    """Pick the pipeline's PCM rates for a call's negotiated Dial formats.

    Output matches Dial's outbound rate exactly, so text-to-speech renders at
    the rate Dial wants and nothing is resampled on the way out. Input is
    pinned to 8k/16k because that is what Silero VAD accepts — a 24 kHz inbound
    format is resampled down rather than handed to the VAD as-is.
    """
    in_rate = FORMAT_SAMPLE_RATES[formats.inbound]
    return (in_rate if in_rate in (8000, 16000) else 16000), FORMAT_SAMPLE_RATES[formats.outbound]


def dial_mark_frame(name: str) -> OutputTransportMessageFrame:
    """A playback checkpoint Dial echoes back once the caller has heard everything queued before it.

    Queue one after the agent's last words when you want to hang up *after* they
    land: ``end_call`` discards whatever Dial still has buffered, so sending it
    straight after the goodbye cuts the goodbye off.
    """
    return OutputTransportMessageFrame(message=ServerMark(name=name).model_dump())


async def _decode(payload: bytes, fmt: AudioFormat, out_rate: int, resampler: BaseAudioResampler) -> bytes:
    """Dial's inbound format -> 16-bit PCM at the pipeline's input rate."""
    in_rate = FORMAT_SAMPLE_RATES[fmt]
    if fmt == "mulaw_8000":
        return await ulaw_to_pcm(payload, in_rate, out_rate, resampler)
    if fmt == "alaw_8000":
        return await alaw_to_pcm(payload, in_rate, out_rate, resampler)
    return await resampler.resample(payload, in_rate, out_rate)


async def _encode(pcm: bytes, in_rate: int, fmt: AudioFormat, resampler: BaseAudioResampler) -> bytes:
    """16-bit PCM from the pipeline -> Dial's outbound format."""
    out_rate = FORMAT_SAMPLE_RATES[fmt]
    if fmt == "mulaw_8000":
        return await pcm_to_ulaw(pcm, in_rate, out_rate, resampler)
    if fmt == "alaw_8000":
        return await pcm_to_alaw(pcm, in_rate, out_rate, resampler)
    return await resampler.resample(pcm, in_rate, out_rate)


class DialFrameSerializer(FrameSerializer):
    """Speaks the Dial Self-Hosted audio protocol on behalf of a Pipecat pipeline.

    Construct one per call, from the ``call_connected`` frame that opens every
    connection::

        msg = parse_dial_audio_message(await websocket.receive_text())
        serializer = DialFrameSerializer(msg.call_id, msg.formats)
    """

    class InputParams(FrameSerializer.InputParams):
        """Configuration parameters for DialFrameSerializer.

        Parameters:
            sample_rate: Optional override for the pipeline's input sample rate.
                Defaults to whatever the pipeline was started with.
            auto_end_call: Whether to hang the call up (``end_call``) when the
                pipeline ends or is cancelled. Turn it off to drive the hangup
                yourself — e.g. goodbye audio, then :func:`dial_mark_frame`,
                then ``end_call`` once the mark echoes back.
            ignore_rtvi_messages: Inherited from FrameSerializer, defaults to True.
        """

        sample_rate: int | None = None
        auto_end_call: bool = True

    def __init__(self, call_id: str, formats: AudioFormats, params: InputParams | None = None):
        """Initialize the DialFrameSerializer.

        Args:
            call_id: Dial's call id, from ``call_connected`` (and the socket path).
            formats: The call's negotiated audio formats, from ``call_connected``.
            params: Configuration parameters.
        """
        params = params or DialFrameSerializer.InputParams()
        super().__init__(params)
        self._params: DialFrameSerializer.InputParams = params

        self._call_id = call_id
        self._formats = formats
        self._sample_rate = 0  # Pipeline input rate, set in setup()

        self._input_resampler = create_stream_resampler(
            clear_after_secs=self._params.resampler_clear_after_secs
        )
        self._output_resampler = create_stream_resampler(
            clear_after_secs=self._params.resampler_clear_after_secs
        )

        # Dial already told us the call is over, or we already asked it to be.
        # Either way `end_call` must not be sent (again) on teardown.
        self._call_over = False

    async def setup(self, setup: FrameProcessorSetup):
        """Set up the serializer with the pipeline's audio configuration.

        Args:
            setup: Configuration object containing setup parameters.
        """
        self._sample_rate = self._params.sample_rate or setup.audio_in_sample_rate

    async def serialize(self, frame: Frame) -> str | bytes | None:
        """Serialize a Pipecat frame into a Dial audio-protocol frame.

        Args:
            frame: The Pipecat frame to serialize.

        Returns:
            A JSON string, or None when the frame has no Dial equivalent.
        """
        if isinstance(frame, (EndFrame, CancelFrame)):
            if not self._params.auto_end_call or self._call_over:
                return None
            self._call_over = True
            return serialize_server_audio_message(ServerEndCall())
        elif isinstance(frame, InterruptionFrame):
            # Barge-in. Dial paces playback, so it is still holding audio the
            # caller has not heard — drop it before the new answer streams out.
            return serialize_server_audio_message(ServerClear())
        elif isinstance(frame, AudioRawFrame):
            payload = await _encode(
                frame.audio, frame.sample_rate, self._formats.outbound, self._output_resampler
            )
            if not payload:
                return None
            return serialize_server_audio_message(
                ServerAudioMedia(payload=base64.b64encode(payload).decode("ascii"))
            )
        elif isinstance(frame, (OutputTransportMessageFrame, OutputTransportMessageUrgentFrame)):
            # Raw protocol frames: the keepalive pong looping back through the
            # pipeline, and any `mark` the bot queued. RTVI chatter is filtered
            # out by the base class.
            if self.should_ignore_frame(frame):
                return None
            return json.dumps(frame.message)

        return None

    async def deserialize(self, data: str | bytes) -> Frame | None:
        """Deserialize a Dial audio-protocol frame into a Pipecat frame.

        Args:
            data: The raw WebSocket frame received from Dial.

        Returns:
            A Pipecat frame, or None for frames the pipeline doesn't need.
        """
        try:
            msg = parse_dial_audio_message(data)
        except ValidationError:
            # A frame we can't parse must not take the call down with it.
            logger.warning(f"[{self._call_id}] unparseable frame from Dial, ignoring")
            return None

        if msg.type == "media":
            pcm = await _decode(
                base64.b64decode(msg.payload),
                self._formats.inbound,
                self._sample_rate,
                self._input_resampler,
            )
            if not pcm:
                return None
            return InputAudioRawFrame(audio=pcm, num_channels=1, sample_rate=self._sample_rate)
        elif msg.type == "dtmf":
            try:
                return InputDTMFFrame(KeypadEntry(msg.digit))
            except ValueError:
                logger.info(f"[{self._call_id}] unknown DTMF digit: {msg.digit}")
                return None
        elif msg.type == "ping_pong":
            # Echo the keepalive back unchanged, via the output transport.
            return OutputTransportMessageUrgentFrame(message=msg.model_dump())
        elif msg.type == "mark":
            logger.debug(f"[{self._call_id}] playback reached mark: {msg.name}")
        elif msg.type == "duration_warning":
            logger.info(f"[{self._call_id}] {msg.seconds_remaining}s left before Dial ends the call")
        elif msg.type == "call_ended":
            # The call is already gone; don't try to hang it up on teardown.
            self._call_over = True
            logger.info(f"[{self._call_id}] call ended: {msg.reason}")
        elif msg.type == "call_connected":
            # The server reads this one itself, before the pipeline starts.
            logger.debug(f"[{self._call_id}] unexpected second call_connected, ignoring")

        return None
