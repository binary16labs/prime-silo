"""AOS-001 Phase 6 — AOS-F20, AOS-F22: Requirements analyst generates PRD + Gherkin.

Red tests — will fail with ModuleNotFoundError until benny/sdlc/requirements.py
is implemented.

F20: generate_prd(requirement) → (prd_dict, gherkin_text)
     The PRD dict has id, title, and at least one feature.
     The Gherkin text contains Feature/Scenario/Given/When/Then blocks.

F22: validate_prd(prd_dict) raises PrdValidationError when the PRD does not
     satisfy schemas/aos/prd_v1.schema.json.
     generate_prd() calls validate_prd() internally — invalid LLM output raises
     PrdValidationError before the caller sees it.
"""

import json

import pytest

from benny.sdlc.requirements import PrdValidationError, generate_prd, validate_prd

# ---------------------------------------------------------------------------
# Shared fixture PRDs
# ---------------------------------------------------------------------------

_VALID_PRD: dict = {
    "id": "PRD-001",
    "title": "Widget Factory",
    "schema_version": "1.0",
    "source_requirement": "Build a widget factory",
    "features": [
        {
            "id": "F-001",
            "title": "Widget creation",
            "description": "Users can create widgets through a form",
            "priority": "must",
            "bdd_scenarios": [
                {
                    "id": "BDD-001",
                    "given": "a user is logged in",
                    "when": "they submit a widget creation form",
                    "then": "a new widget is created and visible in their list",
                }
            ],
        }
    ],
}

_NO_SCENARIOS_PRD: dict = {
    "id": "PRD-002",
    "title": "Simple Feature",
    "features": [
        {
            "id": "F-002",
            "title": "Basic operation",
            "description": "A plain feature with no BDD scenarios",
        }
    ],
}


# ---------------------------------------------------------------------------
# AOS-F20: generate_prd returns (prd_dict, gherkin_text)
# ---------------------------------------------------------------------------


class TestReqEmitsPrdAndFeature:
    """AOS-F20: benny req generates PRD JSON + Gherkin feature file."""

    def test_aos_f20_req_emits_prd_and_feature(self, monkeypatch):
        """F20 primary: generate_prd returns (dict, str) with id + title + features."""
        monkeypatch.setattr(
            "benny.sdlc.requirements._do_call_model",
            lambda model, messages: json.dumps(_VALID_PRD),
        )
        prd, gherkin = generate_prd("Build a widget factory")

        # PRD dict checks
        assert isinstance(prd, dict)
        assert prd["id"] == "PRD-001"
        assert prd["title"] == "Widget Factory"
        assert isinstance(prd["features"], list)
        assert len(prd["features"]) >= 1

        # Gherkin checks — at minimum Feature: and Scenario: blocks
        assert isinstance(gherkin, str)
        assert len(gherkin) > 0

    def test_f20_gherkin_contains_feature_block(self, monkeypatch):
        """Gherkin output contains 'Feature:' keyword."""
        monkeypatch.setattr(
            "benny.sdlc.requirements._do_call_model",
            lambda m, msgs: json.dumps(_VALID_PRD),
        )
        _, gherkin = generate_prd("Build a widget factory")
        assert "Feature:" in gherkin

    def test_f20_gherkin_contains_given_when_then(self, monkeypatch):
        """Gherkin output contains Given / When / Then steps from BDD scenarios."""
        monkeypatch.setattr(
            "benny.sdlc.requirements._do_call_model",
            lambda m, msgs: json.dumps(_VALID_PRD),
        )
        _, gherkin = generate_prd("Build a widget factory")
        assert "Given" in gherkin
        assert "When" in gherkin
        assert "Then" in gherkin

    def test_f20_prd_dict_raises_on_invalid_llm_output(self, monkeypatch):
        """generate_prd raises PrdValidationError if LLM returns an invalid PRD."""
        # Missing required 'features' field
        invalid_prd = {"id": "PRD-001", "title": "Missing features"}
        monkeypatch.setattr(
            "benny.sdlc.requirements._do_call_model",
            lambda m, msgs: json.dumps(invalid_prd),
        )
        with pytest.raises(PrdValidationError):
            generate_prd("Build something invalid")

    def test_f20_prd_without_scenarios_still_returns_gherkin(self, monkeypatch):
        """Features with no BDD scenarios still yield a valid (possibly minimal) Gherkin string."""
        monkeypatch.setattr(
            "benny.sdlc.requirements._do_call_model",
            lambda m, msgs: json.dumps(_NO_SCENARIOS_PRD),
        )
        prd, gherkin = generate_prd("Build a simple feature")
        assert prd["id"] == "PRD-002"
        assert isinstance(gherkin, str)

    def test_f20_model_arg_forwarded(self, monkeypatch):
        """The model argument is forwarded to _do_call_model."""
        called_with_model = []

        def fake_caller(model, messages):
            called_with_model.append(model)
            return json.dumps(_VALID_PRD)

        monkeypatch.setattr("benny.sdlc.requirements._do_call_model", fake_caller)
        generate_prd("Some requirement", model="test-model-x")
        assert called_with_model == ["test-model-x"]

    def test_f20_system_prompt_is_sent(self, monkeypatch):
        """generate_prd sends a system message as part of the messages list."""
        captured_messages = []

        def fake_caller(model, messages):
            captured_messages.extend(messages)
            return json.dumps(_VALID_PRD)

        monkeypatch.setattr("benny.sdlc.requirements._do_call_model", fake_caller)
        generate_prd("Build a widget factory")
        roles = [m["role"] for m in captured_messages]
        assert "system" in roles
        assert "user" in roles

    def test_f20_requirement_text_in_user_message(self, monkeypatch):
        """The free-text requirement appears inside the user message content."""
        captured_messages = []

        def fake_caller(model, messages):
            captured_messages.extend(messages)
            return json.dumps(_VALID_PRD)

        monkeypatch.setattr("benny.sdlc.requirements._do_call_model", fake_caller)
        generate_prd("Build a **special** widget factory!")
        user_content = " ".join(
            m["content"] for m in captured_messages if m["role"] == "user"
        )
        assert "special" in user_content


# ---------------------------------------------------------------------------
# AOS-F22: validate_prd enforces prd_v1.schema.json
# ---------------------------------------------------------------------------


class TestPrdSchemaValidation:
    """AOS-F22: validate_prd enforces the JSON schema."""

    def test_aos_f22_prd_schema_validation(self):
        """F22 primary: validate_prd passes on a fully valid PRD dict."""
        validate_prd(_VALID_PRD)  # must not raise

    def test_f22_minimal_valid_prd(self):
        """Minimal PRD (id + title + one feature) passes validation."""
        minimal = {
            "id": "PRD-MIN",
            "title": "Minimal",
            "features": [{"id": "F-1", "title": "F", "description": "D"}],
        }
        validate_prd(minimal)  # must not raise

    def test_f22_missing_features_rejected(self):
        """F22: PRD without 'features' field fails validation."""
        with pytest.raises(PrdValidationError):
            validate_prd({"id": "PRD-001", "title": "No features"})

    def test_f22_missing_id_rejected(self):
        """F22: PRD without 'id' fails validation."""
        with pytest.raises(PrdValidationError):
            validate_prd(
                {
                    "title": "No id",
                    "features": [{"id": "F-1", "title": "x", "description": "y"}],
                }
            )

    def test_f22_missing_title_rejected(self):
        """F22: PRD without 'title' fails validation."""
        with pytest.raises(PrdValidationError):
            validate_prd(
                {
                    "id": "PRD-001",
                    "features": [{"id": "F-1", "title": "x", "description": "y"}],
                }
            )

    def test_f22_empty_features_rejected(self):
        """F22: PRD with empty features array fails (minItems=1)."""
        with pytest.raises(PrdValidationError):
            validate_prd({"id": "PRD-001", "title": "Empty", "features": []})

    def test_f22_invalid_priority_rejected(self):
        """F22: Feature with an invalid priority enum value fails validation."""
        bad_prd = {
            "id": "PRD-001",
            "title": "Bad priority",
            "features": [
                {
                    "id": "F-1",
                    "title": "t",
                    "description": "d",
                    "priority": "INVALID_PRIORITY",
                }
            ],
        }
        with pytest.raises(PrdValidationError):
            validate_prd(bad_prd)

    def test_f22_additional_properties_rejected(self):
        """F22: additionalProperties=false — unknown top-level key fails."""
        bad_prd = {
            "id": "PRD-001",
            "title": "Extra key",
            "features": [{"id": "F-1", "title": "t", "description": "d"}],
            "unknown_field": "oops",
        }
        with pytest.raises(PrdValidationError):
            validate_prd(bad_prd)

    def test_f22_bdd_scenario_missing_given_rejected(self):
        """F22: BDD scenario without 'given' fails (required field)."""
        bad_prd = {
            "id": "PRD-001",
            "title": "Bad scenario",
            "features": [
                {
                    "id": "F-1",
                    "title": "F",
                    "description": "D",
                    "bdd_scenarios": [
                        {"id": "BDD-1", "when": "something", "then": "outcome"}
                        # missing 'given'
                    ],
                }
            ],
        }
        with pytest.raises(PrdValidationError):
            validate_prd(bad_prd)

    def test_f22_valid_all_priorities(self):
        """Each valid priority value (must/should/could/wont) passes."""
        for priority in ("must", "should", "could", "wont"):
            prd = {
                "id": "PRD-001",
                "title": "Priority test",
                "features": [
                    {
                        "id": "F-1",
                        "title": "F",
                        "description": "D",
                        "priority": priority,
                    }
                ],
            }
            validate_prd(prd)  # must not raise for any valid priority
