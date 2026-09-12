"""The voice agent: a plain Pipecat cascade pipeline, running on a Dial call.

Nothing here is Dial-specific except two lines — the serializer, and the sample
rates it asks for. That is the point: once ``DialFrameSerializer`` translates the
socket, this is the same speech-to-text -> LLM -> text-to-speech pipeline you'd
build on any other Pipecat transport, and any Pipecat service swaps in.

Swap the stack by replacing ``stt`` / ``llm`` / ``tts`` below — see
https://docs.pipecat.ai/server/services/supported-services for what's available.
"""

from __future__ import annotations

import os

from fastapi import WebSocket
from loguru import logger

from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.frames.frames import LLMRunFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.services.cartesia.tts import CartesiaTTSService
from pipecat.services.deepgram.stt import DeepgramSTTService
from pipecat.services.openai.llm import OpenAILLMService
from pipecat.transports.websocket.fastapi import (
    FastAPIWebsocketParams,
    FastAPIWebsocketTransport,
)
from pipecat.workers.runner import WorkerRunner

from dial_sdk.self_hosted_audio import AudioCallConnected

from dial_serializer import DialFrameSerializer, pipeline_sample_rates

# Used when the call carries no instruction of its own.
DEFAULT_INSTRUCTION = (
    "You are a friendly assistant on a phone call. Keep answers short and "
    "conversational — everything you say is spoken aloud, so no emoji, no "
    "bullet points, no markdown."
)


async def run_bot(websocket: WebSocket, call: AudioCallConnected) -> None:
    """Run one call to completion, on an already-accepted Dial WebSocket.

    Args:
        websocket: The accepted WebSocket, past signature verification.
        call: The ``call_connected`` frame that opened it — audio formats,
            caller and callee numbers, and the call's instruction.
    """
    audio_in_rate, audio_out_rate = pipeline_sample_rates(call.formats)

    transport = FastAPIWebsocketTransport(
        websocket=websocket,
        params=FastAPIWebsocketParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            add_wav_header=False,
            serializer=DialFrameSerializer(call.call_id, call.formats),
        ),
    )

    stt = DeepgramSTTService(api_key=os.getenv("DEEPGRAM_API_KEY"))

    llm = OpenAILLMService(
        api_key=os.getenv("OPENAI_API_KEY"),
        settings=OpenAILLMService.Settings(
            model=os.getenv("OPENAI_MODEL", "gpt-4.1"),
            # Dial hands you the instruction the call was placed or answered
            # with — the same prompt the managed agent would have used.
            system_instruction=call.instruction or DEFAULT_INSTRUCTION,
        ),
    )

    tts = CartesiaTTSService(
        api_key=os.getenv("CARTESIA_API_KEY"),
        settings=CartesiaTTSService.Settings(
            voice=os.getenv("CARTESIA_VOICE_ID", "86e30c1d-714b-4074-a1f2-1cb6b552fb49"),
        ),
    )

    context = LLMContext()
    user_aggregator, assistant_aggregator = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(vad_analyzer=SileroVADAnalyzer()),
    )

    pipeline = Pipeline(
        [
            transport.input(),
            stt,
            user_aggregator,
            llm,
            tts,
            transport.output(),
            assistant_aggregator,
        ]
    )

    worker = PipelineWorker(
        pipeline,
        params=PipelineParams(
            enable_metrics=True,
            enable_usage_metrics=True,
            # Match Dial's negotiated formats: text-to-speech renders straight
            # at the rate Dial wants, so only the inbound leg is ever resampled.
            audio_in_sample_rate=audio_in_rate,
            audio_out_sample_rate=audio_out_rate,
        ),
    )

    # The server owns the process, so let it handle Ctrl-C rather than the runner.
    runner = WorkerRunner(handle_sigint=False)
    await runner.add_workers(worker)

    @transport.event_handler("on_client_connected")
    async def on_client_connected(transport, client):
        if call.reconnect:
            # Dial re-established a dropped socket mid-call: the conversation
            # kept going without us, so pick it up rather than greeting again.
            logger.info(f"[{call.call_id}] resumed after reconnect")
            return
        context.add_message(
            {"role": "developer", "content": "Greet the caller briefly and ask how you can help."}
        )
        await worker.queue_frames([LLMRunFrame()])

    @transport.event_handler("on_client_disconnected")
    async def on_client_disconnected(transport, client):
        logger.info(f"[{call.call_id}] socket closed")
        await runner.cancel()

    logger.info(
        f"[{call.call_id}] {call.direction} call {call.from_} -> {call.to}, "
        f"audio {call.formats.inbound} in / {call.formats.outbound} out"
    )
    await runner.run()
