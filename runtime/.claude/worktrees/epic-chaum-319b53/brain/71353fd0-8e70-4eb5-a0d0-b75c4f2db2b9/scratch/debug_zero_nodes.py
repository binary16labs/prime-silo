import sys
import os
from pathlib import Path

sys.path.append(r'c:\Users\nsdha\OneDrive\code\benny')

from benny.graph.code_analyzer import CodeGraphAnalyzer

def debug_scan():
    workspace_root = r'c:\Users\nsdha\OneDrive\code\benny'
    analyzer = CodeGraphAnalyzer(workspace_root)
    
    print(f"Ignore Patterns: {analyzer.ignore_patterns}")
    
    start_path = analyzer.workspace_root / ""
    print(f"Scanning from: {start_path}")
    
    scanned_count = 0
    for root, _, files in os.walk(start_path):
        if analyzer._should_ignore(root):
            # print(f"Ignoring Dir: {root}")
            continue
        for file in files:
            full_path = os.path.join(root, file)
            if analyzer._should_ignore(full_path):
                continue
            ext = os.path.splitext(file)[1].lower()
            if ext in analyzer.parsers:
                scanned_count += 1
                if scanned_count < 10:
                    print(f"Accepted: {full_path}")
    
    print(f"Total files that would be scanned: {scanned_count}")

if __name__ == "__main__":
    debug_scan()
