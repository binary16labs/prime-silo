"""
Audio Routes - STT (Whisper) and TTS (Kokoro) orchestration via Lemonade
"""

from fastapi import APIRouter, HTTPException, UploadFile, File, Form
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel
import httpx
import os
import io
import json
from typing import Optional

from ..core.models import LOCAL_PROVIDERS, call_model, get_active_model

router = APIRouter()

LEMONADE_URL = "http://127.0.0.1:13305/api/v1"

@router.post("/transcribe")
async def transcribe_audio(file: UploadFile = File(...), workspace: str = "default"):
    """Transcribe audio using Lemonade's Whisper (NPU optimized)"""
    try:
        # Resolve STT model via role
        stt_model = await get_active_model(workspace, role="stt")
        # Strip provider prefix if present (e.g. 'lemonade/Whisper...')
        model_id = stt_model.split('/')[-1] if '/' in stt_model else stt_model
        
        content = await file.read()
        async with httpx.AsyncClient(timeout=60.0) as client:
            files = {'file': ("audio.wav", content, "audio/wav")}
            data = {'model': model_id}
            resp = await client.post(f"{LEMONADE_URL}/audio/transcriptions", files=files, data=data)
            if resp.status_code != 200:
                raise HTTPException(resp.status_code, f"Lemonade transcription failed: {resp.text}")
            return resp.json()
    except Exception as e:
        raise HTTPException(500, f"STT failed: {str(e)}")

@router.post("/speech")
async def text_to_speech(text: str = Form(...), voice: str = "af_sky", workspace: str = "default"):
    """Synthesize speech using Lemonade's Kokoro (TTS)"""
    try:
        # Resolve TTS model via role
        tts_model = await get_active_model(workspace, role="tts")
        model_id = tts_model.split('/')[-1] if '/' in tts_model else tts_model

        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(
                f"{LEMONADE_URL}/audio/speech",
                json={"model": model_id, "input": text, "voice": voice}
            )
            if resp.status_code != 200:
                raise HTTPException(resp.status_code, f"Lemonade synthesis failed: {resp.text}")
            return Response(content=resp.content, media_type="audio/mpeg")
    except Exception as e:
        raise HTTPException(500, f"TTS failed: {str(e)}")

class VoiceChatRequest(BaseModel):
    notebook_id: str
    model: str = "qwen3-tk-4b-FLM"
    voice: str = "af_sky"

@router.post("/talk")
async def voice_chat(
    file: UploadFile = File(...),
    notebook_id: str = Form(...),
    model: str = Form("qwen3-tk-4b-FLM"),
    voice: str = Form("af_sky"),
    workspace: str = "default"
):
    try:
        print(f"--- Audio Talk Request Start [NB: {notebook_id}] ---")
        content = await file.read()
        print(f"Step 1: Sending {len(content)} bytes to Lemonade Whisper at {LEMONADE_URL}")
        
        async with httpx.AsyncClient(timeout=60.0) as client:
            # 1. Transcribe
            # Resolve STT model via role
            stt_model = await get_active_model(workspace, role="stt")
            stt_id = stt_model.split('/')[-1] if '/' in stt_model else stt_model
            
            files = {'file': ("voice.wav", content, "audio/wav")}
            data = {'model': stt_id}
            
            stt_resp = await client.post(
                f"{LEMONADE_URL}/audio/transcriptions",
                files=files,
                data=data
            )
            
            if stt_resp.status_code != 200:
                 print(f"STT Failed: {stt_resp.status_code} - {stt_resp.text}")
                 raise HTTPException(stt_resp.status_code, f"STT failed: {stt_resp.text}")
            
            transcription = stt_resp.json().get("text", "")
            print(f"Step 1 Success: '{transcription}'")
            if not transcription:
                return {"error": "No speech detected", "transcript": ""}

            # 2. Query LLM
            # Resolve Chat model via role
            active_chat_model = await get_active_model(workspace, role="chat")
            print(f"Step 2: Querying LLM {active_chat_model} with transcription...")
            from .chat_routes import load_chat_history, save_chat_history, ChatMessage, retrieve_context, build_prompt
            
            # Workspace guard: ensure notebook directory exists
            from ..core.workspace import get_workspace_path
            nb_dir = get_workspace_path(workspace) / "notebooks" / notebook_id
            nb_dir.mkdir(parents=True, exist_ok=True)
            
            history = load_chat_history(notebook_id, workspace)
            context = retrieve_context(notebook_id, transcription, top_k=5, workspace=workspace)
            prompt = build_prompt(transcription, context, history)
            
            assistant_text = await call_model(
                model=active_chat_model,
                messages=[{"role": "user", "content": prompt}],
                temperature=0.7
            )
            print(f"Step 2 Success: Got {len(assistant_text)} chars from assistant")
            
            # Save history
            from datetime import datetime
            history.append(ChatMessage(role="user", content=transcription, timestamp=datetime.now()))
            history.append(ChatMessage(role="assistant", content=assistant_text, timestamp=datetime.now()))
            save_chat_history(notebook_id, history, workspace)

            # 3. Synthesize
            # Resolve TTS model via role
            tts_model_resolved = await get_active_model(workspace, role="tts")
            tts_id = tts_model_resolved.split('/')[-1] if '/' in tts_model_resolved else tts_model_resolved

            print(f"Step 3: Synthesizing speech with {tts_id}...")
            tts_resp = await client.post(
                f"{LEMONADE_URL}/audio/speech",
                json={
                    "model": tts_id,
                    "input": assistant_text,
                    "voice": voice
                }
            )
            
            if tts_resp.status_code != 200:
                 print(f"TTS Step failed: {tts_resp.status_code} - {tts_resp.text}")
                 return {
                     "transcript": transcription,
                     "answer": assistant_text,
                     "audio_error": tts_resp.text
                 }

            import base64
            audio_base64 = base64.b64encode(tts_resp.content).decode('ascii')
            print(f"Step 3 Success: Got {len(audio_base64)} bytes of base64 audio")
            
            return {
                "transcript": transcription,
                "answer": assistant_text,
                "audio": audio_base64,
                "media_type": "audio/mpeg"
            }
            
    except Exception as e:
        import traceback
        trace = traceback.format_exc()
        print(f"Voice Chat Hub failed: {e}\n{trace}")
        raise HTTPException(500, detail=f"Voice Interaction Internals: {str(e)}")
