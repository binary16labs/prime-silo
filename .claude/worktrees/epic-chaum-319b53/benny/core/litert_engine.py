import os
import asyncio
from typing import Optional
from pathlib import Path

# MediaPipe LLM Inference import
# Note: On Windows, GenAI (llm_inference) is often missing from standard pip wheels.
try:
    import mediapipe as mp
    from mediapipe.tasks.python.genai import llm_inference
except (ImportError, ModuleNotFoundError, AttributeError):
    mp = None
    llm_inference = None

class LiteRTEngine:
    """
    Singleton manager for LiteRT (MediaPipe) LLM Inference.
    Handles model loading and thread-pooled execution for high-performance extraction.
    """
    _instance = None
    _engine = None
    _model_path = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super(LiteRTEngine, cls).__new__(cls)
        return cls._instance

    @classmethod
    def is_available(cls) -> bool:
        """Check if MediaPipe GenAI is functional on this platform."""
        return llm_inference is not None

    @classmethod
    def initialize(cls, model_path: Optional[str] = None):
        """Pre-load the model into memory/NPU."""
        if not cls.is_available():
            # On Windows, we shim this to return gracefully, letting the caller decide fallback.
            print("LiteRT (MediaPipe GenAI) is not available on this platform. Requests will fallback to NPU server.")
            return

        if cls._engine is not None and cls._model_path == model_path:
            return

        # Default model path if none provided
        if model_path is None:
            base_dir = Path(__file__).parent.parent
            model_path = str(base_dir / "models" / "litert" / "gemma-2b-it-gpu-int4.bin")

        if not os.path.exists(model_path):
            raise FileNotFoundError(f"LiteRT model not found at {model_path}. Please place a compatible .bin file there.")

        print(f"Initializing LiteRT Engine with model: {model_path}")
        
        # Configure MediaPipe LLM Options
        # Note: 'GPU' backend is often preferred on Windows for NPU/GPU acceleration
        options = llm_inference.LlmInferenceOptions(
            model_bundle_path=model_path,
            max_tokens=1024,
            temperature=0.3,
            top_k=40
        )
        
        try:
            cls._engine = llm_inference.LlmInference.create_from_options(options)
            cls._model_path = model_path
            print("LiteRT Engine initialized successfully.")
        except Exception as e:
            print(f"Failed to initialize LiteRT Engine: {e}")
            raise e

    @classmethod
    async def generate(cls, prompt: str, model_path: Optional[str] = None) -> str:
        """Run inference in a separate thread to avoid blocking the event loop."""
        if cls._engine is None:
            cls.initialize(model_path)
        
        # MediaPipe's generate_response is synchronous, so we use to_thread
        return await asyncio.to_thread(cls._engine.generate_response, prompt)

    @classmethod
    def close(cls):
        """Release the engine resources."""
        if cls._engine:
            cls._engine.close()
            cls._engine = None
            cls._model_path = None
