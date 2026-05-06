import sys
import os

path = r"C:\Users\nsdha\OneDrive\code\benny\frontend\src\components\Studio\CodeGraphCanvas.tsx"
with open(path, "r", encoding="utf-8") as f:
    lines = f.readlines()

new_lines = [l for l in lines if " bitumen" not in l]

with open(path, "w", encoding="utf-8") as f:
    f.writelines(new_lines)
print(f"Fixed {path}, removed {len(lines) - len(new_lines)} lines.")
