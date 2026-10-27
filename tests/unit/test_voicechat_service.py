"""Installed fork contract checks; no GPU, server or production database required."""
import asyncio
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import wave

from deploy.voicechat_service import VoiceChat, create_app, validate_wav


def wav_bytes(rate=16000, channels=1, seconds=0.1):
    stream = io.BytesIO()
    with wave.open(stream, "wb") as wav:
        wav.setnchannels(channels)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(b"\x00\x00" * int(rate * seconds) * channels)
    return stream.getvalue()


class WavTests(unittest.TestCase):
    def test_supported_format(self):
        self.assertEqual(validate_wav(wav_bytes(), 16000, 30), 0.1)

    def test_invalid_formats_and_truncation(self):
        for data in [b"bad", wav_bytes(22050), wav_bytes(channels=2),
                     wav_bytes(seconds=0), wav_bytes()[:-2]]:
            with self.subTest(data_length=len(data)), self.assertRaises(ValueError):
                validate_wav(data, 16000, 30)

    def test_bounded_duration(self):
        with self.assertRaises(ValueError):
            validate_wav(wav_bytes(seconds=1), 16000, 0.5)


class ForkTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.backend = VoiceChat("/unused", "GPU-test")
        self.backend.directory = tempfile.TemporaryDirectory()
        self.reader = asyncio.StreamReader()
        self.backend.process = type("Process", (), {"stdout": self.reader})()
        self.commands = []

        async def command(data):
            self.commands.append(data)
        self.backend.command = command

    async def asyncTearDown(self):
        self.backend.directory.cleanup()

    async def event(self, value):
        self.reader.feed_data((json.dumps(value) + "\n").encode())
        return await self.backend.event()

    async def test_ready_requires_audio_model(self):
        with self.assertRaises(RuntimeError):
            await self.event({"kind": "ready", "tts": False})
        await self.event({"kind": "ready", "tts": True})
        self.assertTrue(self.backend.ready)

    async def test_turn_has_server_owned_paths_and_removes_audio(self):
        self.backend.ready = True
        await self.backend.turn(wav_bytes())
        with self.assertRaises(ValueError):
            await self.backend.turn(wav_bytes())
        command = self.commands[0]
        self.assertEqual(command["cmd"], "turn")
        output = Path(command["out"])
        output.write_bytes(wav_bytes(22050))
        result = await self.event({"kind": "turn_end", "text": "Hello",
                                   "audio": "/untrusted/output.wav"})
        self.assertEqual(result["audio_bytes"], wav_bytes(22050))
        self.assertNotIn("audio", result)
        self.assertFalse(output.exists())
        self.assertFalse(Path(command["audio"]).exists())
        self.assertFalse(self.backend.busy)
        await self.backend.turn(wav_bytes())  # second turn admitted

    async def test_missing_output_and_failure_are_not_success(self):
        self.backend.busy = True
        with self.assertRaises(RuntimeError):
            await self.event({"kind": "turn_end"})
        with self.assertRaises(RuntimeError):
            await self.event({"kind": "turn_end", "failed": True})

    async def test_model_cannot_dispatch_tools(self):
        with self.assertRaisesRegex(RuntimeError, "not enabled"):
            await self.event({"kind": "tool_call", "text": "run_shell"})
        self.assertEqual(self.commands, [])

    async def test_process_exit_is_failure(self):
        self.reader.feed_eof()
        with self.assertRaisesRegex(RuntimeError, "exited"):
            await self.backend.event()

    async def test_recording_before_ready_and_oversize_are_rejected(self):
        with self.assertRaises(ValueError):
            await self.backend.turn(wav_bytes())
        self.backend.ready = True
        with self.assertRaises(ValueError):
            await self.backend.turn(b"x" * 1000000)
        self.assertEqual(self.commands, [])

    async def test_close_escalates_and_cleans_recordings(self):
        class Process:
            returncode = None
            terminated = False
            killed = False

            def terminate(self):
                self.terminated = True

            def kill(self):
                self.killed = True
                self.returncode = -9

            async def wait(self):
                if not self.killed:
                    raise asyncio.TimeoutError()
                return self.returncode

        process = Process()
        self.backend.process = process
        directory = Path(self.backend.directory.name)
        (directory / "input.wav").write_bytes(wav_bytes())
        await self.backend.close()
        self.assertTrue(process.terminated)
        self.assertTrue(process.killed)
        self.assertFalse(directory.exists())


class TransportTests(unittest.TestCase):
    def setUp(self):
        try:
            from fastapi.testclient import TestClient
        except ImportError:
            self.skipTest("FastAPI test dependencies are not installed")
        self.token = "x" * 48
        self.headers = {"Authorization": "Bearer " + self.token}
        self.client = TestClient(create_app("/missing", "GPU-test", self.token))

    def test_health_is_authenticated_and_does_not_claim_readiness(self):
        self.assertEqual(self.client.get("/health").status_code, 401)
        response = self.client.get("/health", headers=self.headers)
        self.assertEqual(response.status_code, 200)
        value = response.json()
        self.assertFalse(value["installed"])
        self.assertFalse(value["ready"])
        self.assertFalse(value["tools"])
        self.assertFalse(value["duplex"])
        self.assertNotIn(self.token, response.text)
        self.assertNotIn("/missing", response.text)

    def test_non_ascii_authorization_is_rejected(self):
        response = self.client.get("/health", headers={b"Authorization": b"Bearer \xff"})
        self.assertEqual(response.status_code, 401)

    def test_socket_auth_and_missing_models(self):
        from starlette.websockets import WebSocketDisconnect
        with self.assertRaises(WebSocketDisconnect):
            with self.client.websocket_connect("/call"):
                pass
        with self.client.websocket_connect("/call", headers=self.headers) as socket:
            event = socket.receive_json()
            self.assertEqual(event["kind"], "error")
            self.assertIn("missing", event["message"])
        self.assertFalse(self.client.get("/health", headers=self.headers).json()["busy"])

    def test_close_json_whitespace_is_supported_and_releases_slot(self):
        closed = []

        async def start(backend):
            backend.deadline = asyncio.get_running_loop().time() + 30

        async def event(backend):
            await asyncio.Future()

        async def close(backend):
            closed.append(True)

        with patch.object(VoiceChat, "start", start), patch.object(VoiceChat, "event", event), \
                patch.object(VoiceChat, "close", close):
            with self.client.websocket_connect("/call", headers=self.headers) as socket:
                socket.send_json({"cmd": "close"})
                self.assertEqual(socket.receive()["type"], "websocket.close")
        self.assertEqual(closed, [True])
        self.assertFalse(self.client.get("/health", headers=self.headers).json()["busy"])


if __name__ == "__main__":
    unittest.main()
