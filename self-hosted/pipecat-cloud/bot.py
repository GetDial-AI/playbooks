"""A voice agent on Pipecat Cloud, reached by Dial's Pipecat Cloud audio target.

The same speech-to-text -> LLM -> text-to-speech pipeline as the self-hosted
``pipecat-python`` playbook, moved into Pipecat Cloud's entrypoint. Dial fetches
a single-use token from Pipecat Cloud's ``/start`` before every connection, so
Pipecat authenticates the socket and there is no ``X-Dial-Signature`` to verify
and no server to run: Pipecat Cloud calls :func:`bot` once per call.

Swap the stack by replacing ``stt`` / ``llm`` / ``tts`` below — see
https://docs.pipecat.ai/server/services/supported-services for what's available.

Env (set as a Pipecat Cloud secret set): DEEPGRAM_API_KEY, OPENAI_API_KEY,
CARTESIA_API_KEY, and optionally OPENAI_MODEL and CARTESIA_VOICE_ID.
"""

from __future__ import annotations

import os

from loguru import logger
from pydantic import ValidationError
from starlette.websockets import WebSocketState

from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.frames.frames import LLMRunFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.runner.types import WebSocketRunnerArguments
from pipecat.services.cartesia.tts import CartesiaTTSService
from pipecat.services.deepgram.stt import DeepgramSTTService
from pipecat.services.openai.llm import OpenAILLMService
from pipecat.transports.websocket.fastapi import (
    FastAPIWebsocketParams,
    FastAPIWebsocketTransport,
)
from pipecat.workers.runner import WorkerRunner

from dial_sdk import parse_dial_audio_message

from dial_serializer import DialFrameSerializer, pipeline_sample_rates

# WebSocket close code for an opening frame that isn't call_connected.
UNSUPPORTED_DATA = 1003

# Used when the call carries no instruction of its own.
DEFAULT_INSTRUCTION = (
    "You are a friendly assistant on a phone call. Keep answers short and "
    "conversational — everything you say is spoken aloud, so no emoji, no "
    "bullet points, no markdown."
)


def call_context(body: dict) -> str:
    """One line of per-call context for the system prompt, from the /start body.

    Dial's ``/start`` body is ``{call_id, direction, from, to}``; Pipecat Cloud
    hands it to the bot as ``runner_args.body``. On an inbound call ``from`` is
    the caller; on an outbound call it's your own Dial number and ``to`` is the
    person you're calling.
    """
    direction = body.get("direction")
    if direction == "inbound":
        return f"This is an inbound call: {body.get('from')} called you."
    if direction == "outbound":
        return f"This is an outbound call: you called {body.get('to')}."
    return ""


async def bot(runner_args: WebSocketRunnerArguments):
    """Pipecat Cloud entrypoint: one Dial call per session."""
    websocket = runner_args.websocket
    if websocket.client_state == WebSocketState.CONNECTING:
        await websocket.accept()

    body = runner_args.body or {}
    logger.info(f"session {runner_args.session_id} body: {body}")

    # The first frame is always call_connected. It carries the audio formats the
    # serializer must speak and the sample rates the pipeline runs at, so it has
    # to be read before the pipeline exists.
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

    # Dial hands you the instruction the call was placed or answered with — the
    # same prompt the managed agent would have used — plus who is on the line.
    instruction = " ".join(
        part for part in (call.instruction or DEFAULT_INSTRUCTION, call_context(body)) if part
    )
    llm = OpenAILLMService(
        api_key=os.getenv("OPENAI_API_KEY"),
        settings=OpenAILLMService.Settings(
            model=os.getenv("OPENAI_MODEL", "gpt-4.1"),
            system_instruction=instruction,
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

    # Pipecat Cloud owns the process, so let it handle signals rather than the runner.
    runner = WorkerRunner(handle_sigint=False)
    await runner.add_workers(worker)

    @transport.event_handler("on_client_connected")
    async def on_client_connected(transport, client):
        if call.reconnect:
            # Dial re-established a dropped socket mid-call (a fresh /start, so a
            # fresh session): the conversation kept going without us, so pick it
            # up rather than greeting again.
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
        f"audio {call.formats.inbound} in / {call.formats.outbound} out, "
        f"reconnect={call.reconnect}"
    )
    await runner.run()
