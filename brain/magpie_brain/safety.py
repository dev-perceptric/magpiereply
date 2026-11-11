"""Privacy masking (Presidio), on the brain's own CPU: card, bank, ID and passport numbers, emails, phone numbers and
IP addresses are replaced with a label like <PHONE_NUMBER> before anything reaches Claude. Names and places stay,
because answers need them ("ship to Canada"). Who the customer is comes from the verified identity, never the text.

Prompt attacks are checked by the review call in engine.py. LLM Guard was the plan, but it hasn't had a release
since May 2025 and its model needs about 1.1 GB of memory; the 8-bit version missed most attacks in testing.
"""

from __future__ import annotations

from typing import Callable

# Pattern-based entities only: these are safe to hide and never needed to answer.
MASKED_ENTITIES = [
    "CREDIT_CARD",
    "IBAN_CODE",
    "US_BANK_NUMBER",
    "US_SSN",
    "US_ITIN",
    "US_PASSPORT",
    "US_DRIVER_LICENSE",
    "UK_NHS",
    "CRYPTO",
    "EMAIL_ADDRESS",
    "PHONE_NUMBER",
    "IP_ADDRESS",
]
# Below this, Presidio's guess is too weak to hide text (a long order number can look like a phone number).
MASK_MIN_SCORE = 0.4

Mask = Callable[[str], str]


def presidio_mask() -> Mask:
    from presidio_analyzer import AnalyzerEngine
    from presidio_analyzer.nlp_engine import NlpEngineProvider
    from presidio_anonymizer import AnonymizerEngine

    nlp = NlpEngineProvider(
        nlp_configuration={"nlp_engine_name": "spacy", "models": [{"lang_code": "en", "model_name": "en_core_web_sm"}]}
    ).create_engine()
    analyzer = AnalyzerEngine(nlp_engine=nlp, supported_languages=["en"])
    anonymizer = AnonymizerEngine()

    def mask(text: str) -> str:
        if not text.strip():
            return text
        found = analyzer.analyze(text=text, language="en", entities=MASKED_ENTITIES, score_threshold=MASK_MIN_SCORE)
        if not found:
            return text
        return anonymizer.anonymize(text=text, analyzer_results=found).text

    return mask
