"""An echo bot on Pipecat Cloud, reached by Dial's Pipecat Cloud audio target.

It plays the caller's audio straight back to them. No speech-to-text, LLM, or
text-to-speech — so no service keys — which makes it the smallest bot that
proves the whole path: Dial fetches a token from Pipecat Cloud's ``/start``,
opens the generic WebSocket with it, and audio flows both ways through
``DialFrameSerializer``. On a call you hear your own voice.

Pipecat Cloud authenticates the connection with its single-use token, so unlike
the self-hosted ``server.py`` there is no ``X-Dial-Signature`` to verify here.
"""

from __future__ import annotations

from loguru import logger
from pydantic import ValidationError
from starlette.websockets import WebSocketState

from pipecat.frames.frames import Frame, InputAudioRawFrame, OutputAudioRawFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.runner.types import WebSocketRunnerArguments
from pipecat.transports.websocket.fastapi import (
    FastAPIWebsocketParams,
    FastAPIWebsocketTransport,
)
from pipecat.workers.runner import WorkerRunner

from dial_sdk import parse_dial_audio_message

from dial_serializer import FORMAT_SAMPLE_RATES, DialFrameSerializer

# WebSocket close code for an opening frame that isn't call_connected.
UNSUPPORTED_DATA = 1003


class Echo(FrameProcessor):
    """Turns every chunk of caller audio into agent audio, unchanged."""

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, InputAudioRawFrame):
            await self.push_frame(
                OutputAudioRawFrame(
                    audio=frame.audio,
                    sample_rate=frame.sample_rate,
                    num_channels=frame.num_channels,
                )
            )
        else:
            await self.push_frame(frame, direction)


async def bot(runner_args: WebSocketRunnerArguments):
    """Pipecat Cloud entrypoint: one Dial call per session."""
    websocket = runner_args.websocket
    if websocket.client_state == WebSocketState.CONNECTING:
        await websocket.accept()

    # Dial sends the /start body (call id, direction, numbers) — log it so the
    # smoke test can confirm it arrived.
    logger.info(f"session {runner_args.session_id} body: {runner_args.body}")

    try:
        call = parse_dial_audio_message(await websocket.receive_text())
    except ValidationError:
        logger.warning("rejected: unparseable opening frame")
        await websocket.close(code=UNSUPPORTED_DATA)
        return
    if call.type != "call_connected":
        logger.warning(f"rejected: expected call_connected, got {call.type}")
        await websocket.close(code=UNSUPPORTED_DATA)
        return

    # Echo needs one rate end to end: run the pipeline at the outbound rate and
    # let the serializer resample the inbound leg to it.
    rate = FORMAT_SAMPLE_RATES[call.formats.outbound]

    transport = FastAPIWebsocketTransport(
        websocket=websocket,
        params=FastAPIWebsocketParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            add_wav_header=False,
            serializer=DialFrameSerializer(call.call_id, call.formats),
        ),
    )

    worker = PipelineWorker(
        Pipeline([transport.input(), Echo(), transport.output()]),
        params=PipelineParams(audio_in_sample_rate=rate, audio_out_sample_rate=rate),
    )
    runner = WorkerRunner(handle_sigint=False)
    await runner.add_workers(worker)

    @transport.event_handler("on_client_disconnected")
    async def on_client_disconnected(transport, client):
        logger.info(f"[{call.call_id}] socket closed")
        await runner.cancel()

    logger.info(
        f"[{call.call_id}] {call.direction} call {call.from_} -> {call.to}, "
        f"audio {call.formats.inbound} in / {call.formats.outbound} out, "
        f"reconnect={call.reconnect}"
    )
    await runner.run()
