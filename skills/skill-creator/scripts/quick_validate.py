#!/usr/bin/env python3
"""
Quick validation script for skills - minimal version
"""

import sys
import re
from pathlib import Path


class FrontmatterParseError(ValueError):
    """Raised when SKILL.md frontmatter cannot be parsed."""


def _unquote_scalar(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
        return value[1:-1]
    return value


def parse_frontmatter(frontmatter_text: str) -> dict:
    """Parse the small YAML subset used by SKILL.md frontmatter.

    This intentionally supports only top-level mappings with scalar values,
    simple nested metadata, and block scalars. It avoids requiring external
    PyYAML for validation in plugin marketplace installs.
    """
    frontmatter: dict = {}
    lines = frontmatter_text.splitlines()
    i = 0
    while i < len(lines):
        raw_line = lines[i]
        stripped = raw_line.strip()
        i += 1

        if not stripped or stripped.startswith("#"):
            continue
        if raw_line[:1].isspace():
            raise FrontmatterParseError(f"Unexpected indented line: {raw_line}")
        if ":" not in raw_line:
            raise FrontmatterParseError(f"Expected key/value pair: {raw_line}")

        key, raw_value = raw_line.split(":", 1)
        key = key.strip()
        value = raw_value.strip()
        if not key:
            raise FrontmatterParseError("Empty key in frontmatter")

        if value in {"|", ">", "|-", ">-"}:
            block_lines: list[str] = []
            while i < len(lines) and (lines[i].startswith("  ") or lines[i].startswith("\t") or not lines[i].strip()):
                block_lines.append(lines[i].strip())
                i += 1
            frontmatter[key] = "\n".join(block_lines) if value.startswith("|") else " ".join(block_lines)
            continue

        if value == "":
            nested: dict[str, str] = {}
            sequence: list[str] = []
            saw_sequence = False
            saw_mapping = False
            while i < len(lines) and (lines[i].startswith("  ") or lines[i].startswith("\t") or not lines[i].strip()):
                nested_line = lines[i]
                i += 1
                if not nested_line.strip():
                    continue
                nested_stripped = nested_line.strip()
                if nested_stripped.startswith("- "):
                    if saw_mapping:
                        raise FrontmatterParseError(f"Cannot mix list and mapping entries: {nested_line}")
                    saw_sequence = True
                    sequence.append(_unquote_scalar(nested_stripped[2:]))
                    continue
                if saw_sequence:
                    raise FrontmatterParseError(f"Cannot mix list and mapping entries: {nested_line}")
                saw_mapping = True
                if ":" not in nested_stripped:
                    raise FrontmatterParseError(f"Expected nested key/value pair: {nested_line}")
                nested_key, nested_value = nested_stripped.split(":", 1)
                nested[nested_key.strip()] = _unquote_scalar(nested_value)
            frontmatter[key] = sequence if saw_sequence else nested
            continue

        frontmatter[key] = _unquote_scalar(value)

    return frontmatter

def validate_skill(skill_path):
    """Basic validation of a skill"""
    skill_path = Path(skill_path)

    # Check SKILL.md exists
    skill_md = skill_path / 'SKILL.md'
    if not skill_md.exists():
        return False, "SKILL.md not found"

    # Read and validate frontmatter
    content = skill_md.read_text()
    if not content.startswith('---'):
        return False, "No YAML frontmatter found"

    # Extract frontmatter
    match = re.match(r'^---\n(.*?)\n---', content, re.DOTALL)
    if not match:
        return False, "Invalid frontmatter format"

    frontmatter_text = match.group(1)

    # Parse frontmatter without requiring external PyYAML.
    try:
        frontmatter = parse_frontmatter(frontmatter_text)
        if not isinstance(frontmatter, dict):
            return False, "Frontmatter must be a YAML dictionary"
    except FrontmatterParseError as e:
        return False, f"Invalid frontmatter: {e}"

    # Define allowed properties
    ALLOWED_PROPERTIES = {'name', 'description', 'license', 'allowed-tools', 'metadata', 'compatibility'}

    # Check for unexpected properties (excluding nested keys under metadata)
    unexpected_keys = set(frontmatter.keys()) - ALLOWED_PROPERTIES
    if unexpected_keys:
        return False, (
            f"Unexpected key(s) in SKILL.md frontmatter: {', '.join(sorted(unexpected_keys))}. "
            f"Allowed properties are: {', '.join(sorted(ALLOWED_PROPERTIES))}"
        )

    # Check required fields
    if 'name' not in frontmatter:
        return False, "Missing 'name' in frontmatter"
    if 'description' not in frontmatter:
        return False, "Missing 'description' in frontmatter"

    # Extract name for validation
    name = frontmatter.get('name', '')
    if not isinstance(name, str):
        return False, f"Name must be a string, got {type(name).__name__}"
    name = name.strip()
    if name:
        # Check naming convention (kebab-case: lowercase with hyphens)
        if not re.match(r'^[a-z0-9-]+$', name):
            return False, f"Name '{name}' should be kebab-case (lowercase letters, digits, and hyphens only)"
        if name.startswith('-') or name.endswith('-') or '--' in name:
            return False, f"Name '{name}' cannot start/end with hyphen or contain consecutive hyphens"
        # Check name length (max 64 characters per spec)
        if len(name) > 64:
            return False, f"Name is too long ({len(name)} characters). Maximum is 64 characters."

    # Extract and validate description
    description = frontmatter.get('description', '')
    if not isinstance(description, str):
        return False, f"Description must be a string, got {type(description).__name__}"
    description = description.strip()
    if description:
        # Check for angle brackets
        if '<' in description or '>' in description:
            return False, "Description cannot contain angle brackets (< or >)"
        # Check description length (max 1024 characters per spec)
        if len(description) > 1024:
            return False, f"Description is too long ({len(description)} characters). Maximum is 1024 characters."

    # Validate compatibility field if present (optional)
    compatibility = frontmatter.get('compatibility', '')
    if compatibility:
        if not isinstance(compatibility, str):
            return False, f"Compatibility must be a string, got {type(compatibility).__name__}"
        if len(compatibility) > 500:
            return False, f"Compatibility is too long ({len(compatibility)} characters). Maximum is 500 characters."

    return True, "Skill is valid!"

if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python quick_validate.py <skill_directory>")
        sys.exit(1)
    
    valid, message = validate_skill(sys.argv[1])
    print(message)
    sys.exit(0 if valid else 1)
