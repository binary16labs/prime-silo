import json
with open(r"C:\Users\nsdha\.gemini\antigravity\brain\33f6db95-b904-42a5-b48e-65dbf4f2397d\.system_generated\steps\877\content.md", "r", encoding="utf-8") as f:
    content = f.read()
    # Skip the header lines
    json_str = content.split("\n\n---\n\n")[1]
    data = json.loads(json_str)
    for path in sorted(data["paths"].keys()):
        print(path)
