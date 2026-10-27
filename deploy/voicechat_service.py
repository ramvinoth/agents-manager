#!/usr/bin/env python3
"""Authenticated, single-call WAV transport for the installed llama-voicechat fork.

The model process owns one conversation and is destroyed when its WebSocket ends.
No STT/text-provider/TTS fallback; no model-requested actions are executed here.
Run with VOICECHAT_ROOT, VOICECHAT_GPU, VOICECHAT_TOKEN_FILE and VOICECHAT_HOST.
"""
import asyncio
from collections import deque
import contextlib
import hmac
import io
import json
import os
from pathlib import Path
import tempfile
import wave

MODEL = "nvidia/NVIDIA-NemotronLabs-VoiceChat-11B"
MAX_INPUT = 16000 * 2 * 30 + 4096
MAX_OUTPUT = 22050 * 2 * 180 + 4096


def validate_wav(data, rate, max_seconds):
    try:
        with wave.open(io.BytesIO(data), "rb") as wav:
            if (wav.getnchannels(), wav.getsampwidth(), wav.getframerate(),
                    wav.getcomptype()) != (1, 2, rate, "NONE"):
                raise ValueError("Expected mono PCM16 WAV at %s Hz" % rate)
            frames = wav.getnframes()
            if not 0 < frames <= rate * max_seconds:
                raise ValueError("Audio duration exceeds the supported turn limit")
            if len(wav.readframes(frames)) != frames * 2:
                raise ValueError("Truncated WAV")
            return frames / rate
    except (wave.Error, EOFError) as exc:
        raise ValueError("Invalid WAV") from exc


class VoiceChat:
    def __init__(self, root, gpu):
        self.root = Path(root)
        self.gpu = gpu
        self.process = None
        self.stderr_task = None
        self.logs = deque(maxlen=8)
        self.directory = None
        self.busy = False
        self.ready = False
        self.deadline = 0
        self.files = {
            "binary": self.root / "llama-voicechat.cpp/build/bin/llama-voicechat",
            "model": self.root / "models/nemotron_voicechat_11b-stt-llm-Q4_0.gguf",
            "mmproj": self.root / "models/mmproj-voicechat-perception-Q4_0.gguf",
            "tts": self.root / "models/voicechat-tts-Q4_0.gguf",
            "function_head": self.root / "models/nemotron_voicechat_11b-stt-llm-Q4_0-function-head.gguf",
        }

    def installed(self):
        return all(p.is_file() and p.stat().st_size for p in self.files.values())

    async def start(self):
        if not self.installed():
            raise RuntimeError("Installed model components are missing")
        probe = await asyncio.create_subprocess_exec(
            "nvidia-smi", "-i", self.gpu, "--query-gpu=memory.free",
            "--format=csv,noheader,nounits", stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL)
        try:
            stdout, _ = await asyncio.wait_for(probe.communicate(), 10)
        finally:
            if probe.returncode is None:
                probe.kill()
                await probe.wait()
        # Admission policy, not a claim about the model's exact memory usage.
        if probe.returncode or int(stdout.strip()) < 14000:
            raise RuntimeError("Insufficient free GPU memory; existing workloads were not changed")
        self.directory = tempfile.TemporaryDirectory(prefix="harman-voicechat-")
        env = dict(os.environ, CUDA_VISIBLE_DEVICES=self.gpu,
                   VC_NO_BARGE="1", VC_FORCE_BOS="1")
        self.process = await asyncio.create_subprocess_exec(
            str(self.files["binary"]), "-m", str(self.files["model"]),
            "--mmproj", str(self.files["mmproj"]), "--tts", str(self.files["tts"]),
            "--serve", "-ngl", "99", "--device", "CUDA0", "--tts-device", "CUDA0",
            "--session-seconds", "180", "--extra-decoding-seconds", "30",
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE, env=env, limit=65536)
        self.stderr_task = asyncio.create_task(self._drain_logs())
        self.deadline = asyncio.get_running_loop().time() + 90

    async def _drain_logs(self):
        while True:
            chunk = await self.process.stderr.read(2048)
            if not chunk:
                return
            self.logs.append(chunk.decode("utf-8", errors="replace"))

    async def command(self, value):
        self.process.stdin.write((json.dumps(value) + "\n").encode())
        await self.process.stdin.drain()

    async def turn(self, data):
        if not self.ready or self.busy:
            raise ValueError("Wait for the current turn to finish")
        if len(data) > MAX_INPUT:
            raise ValueError("Audio input too large")
        validate_wav(data, 16000, 30)
        directory = Path(self.directory.name)
        (directory / "input.wav").write_bytes(data)
        (directory / "output.wav").unlink(missing_ok=True)
        self.busy = True
        self.deadline = asyncio.get_running_loop().time() + 120
        await self.command({"cmd": "turn", "audio": str(directory / "input.wav"),
                            "out": str(directory / "output.wav")})

    async def event(self):
        line = await self.process.stdout.readline()
        if not line:
            raise RuntimeError("Nemotron process exited")
        event = json.loads(line)
        if not isinstance(event, dict):
            raise RuntimeError("Invalid model event")
        kind = event.get("kind")
        if kind == "ready":
            if event.get("tts") is not True:
                raise RuntimeError("Nemotron audio generator did not load")
            self.ready = True
        elif kind == "tool_call":
            # Never imply that a worker was launched or execute arbitrary model output.
            raise RuntimeError("Tool delegation is not enabled for this backend yet")
        elif kind == "error" or event.get("failed"):
            raise RuntimeError("Nemotron could not complete this turn")
        elif kind == "turn_end":
            if not self.busy:
                raise RuntimeError("Unexpected turn completion")
            output = Path(self.directory.name) / "output.wav"
            if not output.is_file() or output.stat().st_size > MAX_OUTPUT:
                raise RuntimeError("Nemotron did not produce bounded WAV audio")
            data = output.read_bytes()
            validate_wav(data, 22050, 180)
            output.unlink()
            (Path(self.directory.name) / "input.wav").unlink(missing_ok=True)
            event["audio_bytes"] = data
            self.busy = False
        if kind in ("ready", "turn_end"):
            self.deadline = asyncio.get_running_loop().time() + 120
        event.pop("path", None)
        event.pop("audio", None)
        return event

    async def close(self):
        self.ready = False
        if self.process and self.process.returncode is None:
            self.process.terminate()
            try:
                await asyncio.wait_for(self.process.wait(), 5)
            except asyncio.TimeoutError:
                self.process.kill()
                await self.process.wait()
        if self.stderr_task:
            await self.stderr_task
        if self.directory:
            self.directory.cleanup()


def create_app(root, gpu, token):
    from fastapi import FastAPI, Request, WebSocket
    from fastapi.responses import JSONResponse

    if len(token) < 32 or not gpu.startswith("GPU-"):
        raise ValueError("A strong service token and explicit GPU UUID are required")
    app = FastAPI()
    active = None

    def authorized(headers):
        return hmac.compare_digest(headers.get("authorization", "").encode("utf-8"),
                                   ("Bearer " + token).encode("utf-8"))

    @app.get("/health")
    async def health(request: Request):
        if not authorized(request.headers):
            return JSONResponse({"error": "Unauthorized"}, status_code=401)
        return {"backend": "nemotron-voicechat", "model": MODEL,
                "runtime": "llama-voicechat.cpp", "transport": "wav-turns-v1",
                "installed": VoiceChat(root, gpu).installed(),
                "ready": bool(active and active.ready), "busy": active is not None,
                "input": {"format": "wav-pcm16", "rate": 16000, "channels": 1,
                          "max_seconds": 30},
                "output": {"format": "wav-pcm16", "rate": 22050, "channels": 1},
                "tools": False, "duplex": False}

    @app.websocket("/call")
    async def call(socket: WebSocket):
        nonlocal active
        if not authorized(socket.headers):
            await socket.close(code=1008)
            return
        if active is not None:
            await socket.accept()
            await socket.send_json({"kind": "error", "message": "GPU call slot is occupied"})
            await socket.close(code=1013)
            return
        backend = VoiceChat(root, gpu)
        active = backend  # Claim before the first await; one worker, one GPU slot.
        tasks = []
        try:
            await socket.accept()

            async def receive():
                while True:
                    message = await socket.receive()
                    if message["type"] == "websocket.disconnect":
                        return
                    if message.get("bytes") is not None:
                        await backend.turn(message["bytes"])
                    elif message.get("text") is not None:
                        try:
                            command = json.loads(message["text"])
                        except (ValueError, TypeError):
                            command = None
                        if command == {"cmd": "close"}:
                            return
                        raise ValueError("Send a PCM16 WAV binary frame, or close the connection")
                    else:
                        raise ValueError("Unsupported WebSocket message")

            async def generate():
                await backend.start()
                while True:
                    event = await backend.event()
                    data = event.pop("audio_bytes", None)
                    if data is not None:
                        await socket.send_bytes(data)
                    await socket.send_json(event)

            async def watchdog():
                while True:
                    await asyncio.sleep(1)
                    if backend.deadline and asyncio.get_running_loop().time() > backend.deadline:
                        raise TimeoutError("Nemotron startup, turn or idle deadline exceeded")

            tasks = [asyncio.create_task(receive()), asyncio.create_task(generate()),
                     asyncio.create_task(watchdog())]
            done, _ = await asyncio.wait(tasks, timeout=900,
                                         return_when=asyncio.FIRST_COMPLETED)
            if not done:
                raise TimeoutError("Call lifetime limit reached")
            for task in done:
                task.result()
        except Exception as exc:
            with contextlib.suppress(Exception):
                await socket.send_json({"kind": "error", "message": str(exc) or "Call timed out"})
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            try:
                await backend.close()
            finally:
                active = None
                with contextlib.suppress(Exception):
                    await socket.close()

    return app


if __name__ == "__main__":
    import uvicorn

    app = create_app(os.environ["VOICECHAT_ROOT"], os.environ["VOICECHAT_GPU"],
                     Path(os.environ["VOICECHAT_TOKEN_FILE"]).read_text().strip())
    uvicorn.run(app, host=os.environ["VOICECHAT_HOST"],
                port=int(os.environ.get("VOICECHAT_PORT", "8098")),
                workers=1, ws_max_size=MAX_INPUT, ws_max_queue=1,
                timeout_graceful_shutdown=10)
