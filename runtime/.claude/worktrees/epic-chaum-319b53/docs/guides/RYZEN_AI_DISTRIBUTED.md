# Ryzen AI Distributed Setup: Thinkpad T480 Client Guide

This guide explains how to connect your **Thinkpad T480** to your **Ryzen AI 7** LLM server.

## 1. Machine Identification
- **LLM Server (Ryzen AI 7)**: `192.168.68.134`
- **Workstation (Thinkpad T480)**: Primary Development Client

## 2. Thinkpad IDE Configuration
In your Antigravity IDE (or local client), update the LLM provider settings to point to your Ryzen machine:

- **Base URL**: `http://192.168.68.134:8000/api/v1`
- **Port**: `8000` (Lemonade Server)
- **Model**: `user.Gemma-4-E4B-IT`

## 3. Git Syncing
Since you already have a Git repository for this project:
1.  Clone the repository on the Thinkpad.
2.  Ensure you have a modern Git client (the T480 handles Git extremely well).
3.  Commit/Push from the Thinkpad and Pull on the Ryzen machine if you need to run local tasks there.

## 4. Connectivity Test
Run this from your Thinkpad terminal to verify the connection:

```powershell
# Testing Lemonade API
Invoke-RestMethod -Uri "http://192.168.68.134:8000/api/v1/models" -Method Get
```

## 5. Performance Gains
- **Offloaded RAM**: Moving the IDE and Browser to the Thinkpad reclaims ~4-6 GB of RAM on the Ryzen machine.
- **Improved Throughput**: Parallel workers for ingestion on the Ryzen machine have been increased to **6** workers.
