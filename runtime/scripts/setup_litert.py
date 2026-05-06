import os
import sys
import subprocess
from pathlib import Path

def install_dependencies():
    print("Step 1: Installing MediaPipe and dependencies...")
    try:
        subprocess.check_call([sys.executable, "-m", "pip", "install", "mediapipe>=0.10.11", "numpy<2.0.0"])
        print("\u2705 Dependencies installed successfully.")
    except Exception as e:
        print(f"\u274c Installation failed: {e}")
        return False
    return True

def setup_directories():
    print("\nStep 2: Setting up model directories...")
    model_dir = Path("benny/models/litert")
    model_dir.mkdir(parents=True, exist_ok=True)
    print(f"\u2705 Directory created: {model_dir}")
    return model_dir

def check_hardware():
    print("\nStep 3: Checking hardware environment...")
    import platform
    print(f"OS: {platform.system()} {platform.release()}")
    
    # Check for mediapipe specifically
    try:
        import mediapipe as mp
        print("\u2705 MediaPipe is accessible.")
    except ImportError:
        print("\u274c MediaPipe is not found. Please ensure installation finished.")

def provide_model_instructions(model_dir):
    print("\nStep 4: Model Download Instructions")
    print("-" * 40)
    print("LiteRT (MediaPipe) requires a specific .bin format.")
    print("Please download the Gemma 4 E4B model for LiteRT here:")
    print("https://huggingface.co/litert-community/gemma-4-E4B-it-litert-lm")
    print("\nDownload the file: gemma-4-E4B-it.litertlm")
    print(f"\nOnce downloaded, place the file in:")
    print(f"  {model_dir.absolute()}")
    print("-" * 40)

def main():
    print("=== Benny LiteRT (MediaPipe) Setup Helper ===\n")
    
    # Just helpful check, don't auto-install everything unless requested
    # but we will guide the user.
    
    model_dir = setup_directories()
    check_hardware()
    provide_model_instructions(model_dir)
    
    print("\nNext steps:")
    print(f"1. Run: pip install mediapipe")
    print(f"2. Download the model and place it in the litert directory.")
    print(f"3. Start Benny and select 'LiteRT' as the provider.")

if __name__ == "__main__":
    main()
