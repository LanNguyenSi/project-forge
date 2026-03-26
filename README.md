# project-forge

A web UI for creating new software projects using the full agent toolchain (agent-planforge, scaffoldkit, agent-engineering-playbook). Users fill in a form, the server runs planforge and scaffoldkit in a temp directory, shows a preview of the generated structure (tasks, architecture, file tree), allows review and re-generation, then creates a GitHub repo and pushes on confirmation.

## Overview

`project-forge` is a command-line tool built with **python** and **typer**.
It is distributed as a Python package via PyPI.

## Installation

### Via pip

```bash
pip install project-forge
```

### Via pipx (recommended for isolated install)

```bash
pipx install project-forge
```

### From source

```bash
git clone https://github.com/your-org/project-forge.git
cd project-forge
pip install -e ".[dev]"
```

## Quick Start

```bash
# Show help
project-forge --help

# Show version
project-forge --version

# Run the default command
project-forge run

# Get help for a subcommand
project-forge run --help
```

## Usage

### Global Options

| Option | Description |
|--------|-------------|
| `--help` | Show help and exit |
| `--version` | Show version and exit |
| `--config PATH` | Path to config file (default: `~/.config/project-forge/config.yaml`) |
| `--verbose` | Enable verbose output |
| `--quiet` | Suppress non-error output |
| `--no-color` | Disable colored output |

### Commands

#### `project-forge run`

Execute the primary action.

```bash
project-forge run [OPTIONS] [ARGS]...

Options:
  --dry-run   Show what would happen without making changes
  --output    Output format: text, json, yaml  [default: text]
  --help      Show this message and exit
```

#### `project-forge config`

Manage tool configuration.

```bash
project-forge config show              # Print current config
project-forge config set KEY VALUE     # Set a config value
project-forge config get KEY           # Get a config value
project-forge config reset             # Reset to defaults
```

#### `project-forge version`

Show detailed version information.

```bash
project-forge version
# project-forge v0.1.0
# Language: python
# Framework: typer
# Build: (commit hash)
```

## Configuration

project-forge stores configuration at:

- **Linux/macOS**: `~/.config/project-forge/config.yaml`
- **Windows**: `%APPDATA%\project-forge\config.yaml`

The `--config` flag overrides the default path.

### Example config file

```yaml
# project-forge configuration
output_format: text
color: true
verbose: false
# Add your settings here
```

### Environment Variables

All config keys can be overridden via environment variables prefixed with `PROJECT_FORGE_`:

```bash
export PROJECT_FORGE_OUTPUT_FORMAT=json
export PROJECT_FORGE_VERBOSE=true
```

Priority order (highest to lowest): CLI flags > environment variables > config file > defaults.

## Project Structure

```
project-forge/
├── src/
│   ├── commands/         # One file per subcommand
│   ├── config/           # Config loading and validation
│   └── main.py
├── tests/
│   └── ...               # Test files mirroring src/
├── docs/
│   ├── architecture.md
│   ├── ways-of-working.md
│   └── adrs/
├── AI_CONTEXT.md
└── README.md
```

## Development

### Prerequisites

- Python 3.11+
- [uv](https://github.com/astral-sh/uv) or pip

### Setup

```bash
git clone https://github.com/your-org/project-forge.git
cd project-forge

# Create virtual environment
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate

# Install with dev dependencies
pip install -e ".[dev]"
```

### Running Tests

```bash
pytest tests/
pytest tests/ -v --tb=short   # Verbose output
pytest tests/ --cov=src       # With coverage
```

### Linting and Formatting

```bash
ruff check src/ tests/
ruff format src/ tests/
mypy src/
```

## CI/CD

Continuous integration runs on every pull request and push to `main`:

- Lint and format check
- Unit tests
- Build verification
- Publish to PyPI on tagged releases

See `.github/workflows/` for pipeline definitions.

## Testing

Strategy: **unit-tests**

Tests cover individual commands, argument parsing, config loading, and output formatting.
Run them with the command shown in the Development section above.

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make your changes with tests
4. Run the full test suite
5. Open a pull request

See [ways-of-working](docs/ways-of-working.md) for full contribution guidelines.

## License

MIT License. See [LICENSE](LICENSE) for details.

---

*Generated with [ScaffoldKit](https://github.com/scaffoldkit)*
