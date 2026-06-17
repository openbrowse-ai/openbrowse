---
name: python-env
description: Pyodide Python runtime reference for executePython. Load this whenever you're about to write Python code, install a package via micropip, generate PDFs/Excel/Word/PowerPoint, fetch data over HTTP from Python, or follow a skill that calls for tools like reportlab, pdftoppm, subprocess, or pip. Covers the pre-built package list, browser-env substitutions for Linux-flavored skills (pdftoppm→get_pixmap, subprocess→unavailable), pyfetch idioms, and common pitfalls like module-level `return` and latin-1 unicode errors.
---

# `python-env` Skill: Pyodide Runtime Guide

You are running CPython 3 inside a WebAssembly sandbox (Pyodide) in the user's browser, **not** a standard Linux container. This has major implications for what packages are available and how code executes. 

**Read this document before writing non-trivial Python code or attempting to install packages.**

## 1. Execution Model & Filesystem

*   **Module-level execution:** Code executes at the top level of a module. **DO NOT use the `return` statement at the top level** (it will cause a `SyntaxError`). The value of the *last expression* in your code is automatically returned to the caller.
*   **Top-level await:** Supported. You can use `await` without wrapping it in an `async` function.
*   **Filesystem:**
    *   `/workspace` (read/write, persistent) - This is your current working directory. Read/write user files here.
    *   `/skills` (read-only) - Files bundled with skills.
    *   Everything else is a temporary in-memory filesystem that resets.
*   **Getting data into `/workspace` from a page or JS sandbox:** Don't pass large payloads through tool results. `executeOnPage` and `executeCode` both accept a `saveAs: "<path>"` parameter that writes their return value directly to `/workspace`, so Python can `open()` it on the next call. See the `data-plumbing` skill for the canonical recipe.

## 2. Package Availability

Pyodide cannot compile C extensions on the fly. Packages fall into three categories:

### Category 1: Pre-built (Auto-loaded with `allow_network: true`)
With `allow_network: true`, Pyodide fetches these wheels from its CDN the first time you `import` them and caches them in memory for the rest of the conversation. **No `micropip.install` needed — just `import` them.**

*Note on mismatched names: Pyodide correctly auto-loads even when the import name differs from the package name. Just `import` the right name (e.g., `import fitz` for pymupdf).*

*   **Data:** `pandas`, `numpy`, `scipy`, `scikit-learn` (`import sklearn`)
*   **Documents/Images:** `pymupdf` (`import fitz`), `pillow` (`import PIL`)
*   **XML/HTML:** `lxml`, `beautifulsoup4` (`import bs4`)
*   **Misc:** `pyyaml` (`import yaml`), `cryptography`

### Category 2: Pure-Python PyPI Packages (Requires `allow_network: true` + `micropip`)
These must be explicitly installed before you import them. They work because they contain no C code.

*   **Office/Excel:** `openpyxl`, `xlsxwriter`, `python-docx`, `python-pptx`
*   **PDF Write:** `fpdf2` (Note: defaults to latin-1 font; load a TTF for Unicode!)
*   **PDF Read:** `pypdf`, `pdfplumber`

*How to install:*
```python
import micropip
await micropip.install("openpyxl")
import openpyxl
```

### Category 3: WON'T WORK (C extensions not built for Pyodide)
If you try to install these, `micropip` will fail with "Can't fetch metadata" or similar.
*   **FAILED:** `weasyprint`, `python-magic`, `psycopg2`
*   **FAILED:** Anything requiring `subprocess` (e.g., `pdftoppm`, `git`, `soffice`, `ffmpeg`)

## 3. Skill Translation Guide (Linux → Browser)

Many skills (like `pdf` or `office` skills from skills.sh) assume a standard Linux environment. When following such a skill, you **must** apply these substitutions:

| Skill says to use... | In Pyodide, substitute with... |
| :--- | :--- |
| `pip install X` | `import micropip; await micropip.install("X")` (with `allow_network: true`) |
| `reportlab` | `reportlab` works perfectly (Category 2, install via micropip). No substitution needed! |
| `pdftoppm` | `import fitz; doc = fitz.open('file.pdf'); pix = doc[0].get_pixmap(); pix.save('out.png')` (Requires `allow_network: true` for auto-load) |
| `subprocess.run([...])` | **Not available.** Find a pure-Python library alternative. |
| `requests.get(...)` | `from pyodide.http import pyfetch; resp = await pyfetch(...)` |
| `urllib.request.urlopen` | Use `pyfetch` instead. Pyodide's `urllib` patch is unreliable for HTTPS. |
| `weasyprint` (HTML→PDF) | **Not available.** Generate PDF directly using `pymupdf` or `fpdf2`. |

## 4. Common Errors & Fixes

| Error Message | Root Cause | Fix |
| :--- | :--- | :--- |
| `SyntaxError: 'return' outside function` | Used `return` at top level | Remove `return`. Just leave the expression on the last line. |
| `Failed to fetch` during micropip install | Network is blocked | You forgot to set `allow_network: true` on the tool call. |
| `Can't fetch metadata for X` | Package requires C extensions (Category 3) | Find a pure-Python alternative (e.g., `openpyxl` instead of some C-based Excel reader). |
| `<urlopen error unknown url type: https>` | Used `urllib` | Use `from pyodide.http import pyfetch; await pyfetch("https...")` |
| `UnicodeEncodeError: 'latin-1' codec can't encode...` (in `fpdf2`) | Default font lacks characters (like em-dash `—` or `⌥`) | Either strip the characters, OR download/load a TTF font that supports them into `fpdf2`. |
| `ModuleNotFoundError: No module named 'fitz'` (or `PIL`, `bs4`, etc) | Pyodide auto-load failed because network was off | You called `executePython` without `allow_network: true`. Re-call with `allow_network: true` so Pyodide can auto-load the package. |

## 5. Idioms & Examples

**Example 1: Fetching data (Network)**
*Requires tool param: `allow_network: true`*
```python
from pyodide.http import pyfetch
response = await pyfetch("https://api.github.com/repos/openbrowse-ai/openbrowse")
data = await response.json()
data["stargazers_count"] # This expression is returned
```

**Example 2: Installing packages and doing work**
*Requires tool param: `allow_network: true`*
```python
import micropip
# Install pure Python packages concurrently
await micropip.install(["openpyxl", "fpdf2"])

import openpyxl
wb = openpyxl.Workbook()
ws = wb.active
ws["A1"] = "Hello from Pyodide"
wb.save("test.xlsx") # Saves to /workspace/test.xlsx

# Return a success dictionary
{"success": True, "file": "test.xlsx"}
```

**Example 3: Checking if a package is available**
```python
import importlib.util
is_available = importlib.util.find_spec("pymupdf") is not None
is_available
```
