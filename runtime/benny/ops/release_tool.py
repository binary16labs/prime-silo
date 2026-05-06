import sys
import os
import yaml
import json
import subprocess
from pathlib import Path
from rich.console import Console
from rich.table import Table
from rich.panel import Panel
from rich.live import Live
from rich.progress import Progress, SpinnerColumn, TextColumn

# Use ASCII for Windows console compatibility
console = Console(force_terminal=True, safe_box=True)

CONFIG_PATH = Path("docs/requirements/release_gates.yaml")

def run_gate_test(test_name: str):
    """Run a specific gate test via pytest"""
    cmd = [sys.executable, "-m", "pytest", "tests/release/test_release_gates.py", "-k", test_name, "-q"]
    result = subprocess.run(cmd, capture_output=True, text=True)
    return result.returncode == 0, result.stdout + result.stderr

def main():
    if not CONFIG_PATH.exists():
        console.print(f"[red]Error:[/red] Release config not found at {CONFIG_PATH}")
        sys.exit(1)
        
    with open(CONFIG_PATH, "r") as f:
        config = yaml.safe_load(f)["gates"]
        
    console.print(Panel.fit("[bold blue]Benny 6-Sigma Release Audit[/bold blue]", border_style="blue"))
    
    table = Table(title="Quality Gate Status", expand=True)
    table.add_column("Gate", style="cyan")
    table.add_column("Description", style="white")
    table.add_column("Result", justify="center")
    table.add_column("Details", style="dim")
    
    overall_pass = True
    
    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        transient=True,
    ) as progress:
        
        # G-COV
        progress.add_task(description="Auditing Coverage (G-COV)...", total=1)
        passed, log = run_gate_test("test_gate_g_cov")
        table.add_row("G-COV", config["G-COV"]["name"], "[green]PASS[/green]" if passed else "[red]FAIL[/red]", "85% Target")
        if not passed: overall_pass = False
        
        # G-SR1
        progress.add_task(description="Auditing Path Safety (G-SR1)...", total=1)
        passed, log = run_gate_test("test_gate_g_sr1")
        table.add_row("G-SR1", config["G-SR1"]["name"], "[green]PASS[/green]" if passed else "[red]FAIL[/red]", "408 Ratchet")
        if not passed: overall_pass = False
        
        # G-LAT
        progress.add_task(description="Benchmarking Latency (G-LAT)...", total=1)
        passed, log = run_gate_test("test_gate_g_lat")
        table.add_row("G-LAT", config["G-LAT"]["name"], "[green]PASS[/green]" if passed else "[red]FAIL[/red]", "<300ms Median")
        if not passed: overall_pass = False
        
        # G-ERR
        progress.add_task(description="Stress Testing (G-ERR)...", total=1)
        passed, log = run_gate_test("test_gate_g_err")
        table.add_row("G-ERR", config["G-ERR"]["name"], "[green]PASS[/green]" if passed else "[red]FAIL[/red]", "10/10 Success")
        if not passed: overall_pass = False
        
    console.print(table)
    
    if overall_pass:
        console.print("\n[bold green]READY FOR RELEASE[/bold green]")
        sys.exit(0)
    else:
        console.print("\n[bold red]RELEASE BLOCKED: Quality Floor Violations[/bold red]")
        sys.exit(1)

if __name__ == "__main__":
    main()
