try:
    import whisper
    print("whisper is installed")
except ImportError:
    print("whisper is NOT installed")

try:
    import kokoro
    print("kokoro is installed")
except ImportError:
    print("kokoro is NOT installed")
