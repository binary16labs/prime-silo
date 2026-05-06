try:
    import mediapipe as mp
    print(f"IMPORT_SUCCESS: {mp.__version__}")
except ImportError as e:
    print(f"IMPORT_ERROR: {e}")
except Exception as e:
    print(f"OTHER_ERROR: {e}")
