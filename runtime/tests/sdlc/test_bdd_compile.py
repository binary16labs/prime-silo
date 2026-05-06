"""AOS-001 Phase 6 — AOS-F21: compile_to_pytest produces deterministic pytest stubs.

Red tests — will fail with ModuleNotFoundError until benny/sdlc/bdd.py
is implemented.

F21: benny.sdlc.bdd.compile_to_pytest(feature_text) -> str
     Produces a pytest-compatible test stub file.
     Stubs are deterministic: re-running on the same feature produces byte-identical
     output regardless of Python minor version (R7 mitigation: sorted iteration,
     stable slug transform).
"""

import pytest

from benny.sdlc.bdd import compile_to_pytest

# ---------------------------------------------------------------------------
# Test fixtures
# ---------------------------------------------------------------------------

_SIMPLE_FEATURE = """\
Feature: Widget creation

  Scenario: User creates a widget
    Given a logged-in user
    When they submit the widget creation form
    Then a new widget appears in their dashboard
"""

_MULTI_SCENARIO_FEATURE = """\
Feature: User management

  Scenario: Admin creates user
    Given an admin is logged in
    When they create a new user account
    Then the user appears in the admin user list

  Scenario: Admin deletes user
    Given an admin is logged in
    When they delete an existing user
    Then the user is removed from the system
"""

_NO_SCENARIO_FEATURE = "Feature: Empty feature\n"


# ---------------------------------------------------------------------------
# AOS-F21: compile_to_pytest is deterministic
# ---------------------------------------------------------------------------


class TestCompileToPytest:
    """AOS-F21: compile_to_pytest produces sorted, byte-identical stubs."""

    def test_aos_f21_compile_to_pytest_deterministic(self):
        """F21 primary: same input → byte-identical output on two consecutive calls."""
        result1 = compile_to_pytest(_SIMPLE_FEATURE)
        result2 = compile_to_pytest(_SIMPLE_FEATURE)
        assert result1 == result2, (
            "compile_to_pytest is non-deterministic: two calls on the same input "
            "produced different output"
        )

    def test_f21_deterministic_called_ten_times(self):
        """F21 determinism holds across 10 consecutive calls (R7 mitigation)."""
        first = compile_to_pytest(_SIMPLE_FEATURE)
        for _ in range(9):
            assert compile_to_pytest(_SIMPLE_FEATURE) == first

    def test_f21_output_is_valid_python(self):
        """compile_to_pytest output must be parseable Python (no SyntaxError)."""
        result = compile_to_pytest(_SIMPLE_FEATURE)
        compile(result, "<generated>", "exec")  # raises SyntaxError if invalid

    def test_f21_multi_scenario_output_is_valid_python(self):
        """Multi-scenario output is also valid Python."""
        result = compile_to_pytest(_MULTI_SCENARIO_FEATURE)
        compile(result, "<generated>", "exec")

    def test_f21_output_contains_pytest_import(self):
        """Output must import pytest so stubs can call pytest.fail()."""
        result = compile_to_pytest(_SIMPLE_FEATURE)
        assert "import pytest" in result

    def test_f21_output_contains_test_function(self):
        """Each scenario produces a test_ function in the output."""
        result = compile_to_pytest(_SIMPLE_FEATURE)
        assert "def test_" in result

    def test_f21_output_has_pytest_fail_stub(self):
        """Each stub calls pytest.fail() to flag itself as not yet implemented."""
        result = compile_to_pytest(_SIMPLE_FEATURE)
        assert "pytest.fail" in result

    def test_f21_given_when_then_in_output(self):
        """The Given / When / Then text from the scenario appears in the output."""
        result = compile_to_pytest(_SIMPLE_FEATURE)
        assert "logged-in user" in result
        assert "widget creation form" in result
        assert "dashboard" in result

    def test_f21_multi_scenario_deterministic(self):
        """Multi-scenario features are also deterministic."""
        result1 = compile_to_pytest(_MULTI_SCENARIO_FEATURE)
        result2 = compile_to_pytest(_MULTI_SCENARIO_FEATURE)
        assert result1 == result2

    def test_f21_scenarios_are_sorted(self):
        """Scenarios are emitted in alphabetically sorted order (determinism guarantee)."""
        result = compile_to_pytest(_MULTI_SCENARIO_FEATURE)
        # Extract all `def test_…` lines in order of appearance
        test_defs = [
            line.strip()
            for line in result.splitlines()
            if line.strip().startswith("def test_")
        ]
        assert len(test_defs) == 2, f"Expected 2 test functions, got: {test_defs}"
        assert test_defs == sorted(test_defs), (
            f"Test functions are not in sorted order: {test_defs}"
        )

    def test_f21_empty_feature_returns_valid_python(self):
        """A feature with no scenarios returns a valid Python file (just the header)."""
        result = compile_to_pytest(_NO_SCENARIO_FEATURE)
        compile(result, "<generated>", "exec")  # no SyntaxError
        assert "import pytest" in result

    def test_f21_empty_feature_no_test_functions(self):
        """A feature with no scenarios produces no test_ functions."""
        result = compile_to_pytest(_NO_SCENARIO_FEATURE)
        assert "def test_" not in result

    def test_f21_output_has_do_not_edit_header(self):
        """Output starts with the DO NOT EDIT auto-generation comment."""
        result = compile_to_pytest(_SIMPLE_FEATURE)
        assert "Auto-generated" in result or "DO NOT EDIT" in result

    def test_f21_different_features_produce_different_output(self):
        """Two different feature texts produce different (but both deterministic) outputs."""
        out1 = compile_to_pytest(_SIMPLE_FEATURE)
        out2 = compile_to_pytest(_MULTI_SCENARIO_FEATURE)
        assert out1 != out2

    def test_f21_scenario_slug_is_valid_identifier(self):
        """The generated test function name is a valid Python identifier."""
        import keyword

        result = compile_to_pytest(_SIMPLE_FEATURE)
        for line in result.splitlines():
            stripped = line.strip()
            if stripped.startswith("def test_"):
                fn_name = stripped[len("def "):].split("(")[0]
                assert fn_name.isidentifier(), f"Not a valid identifier: {fn_name!r}"
                assert not keyword.iskeyword(fn_name)
