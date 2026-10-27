import uuid
from datetime import datetime, timedelta
from types import SimpleNamespace as NS

import pytest

import veqen


def test_langchain_handler_reads_standard_usage_metadata(ledger):
    from langchain_core.messages import AIMessage
    from langchain_core.outputs import ChatGeneration, LLMResult

    from veqen.integrations.langchain import VeqenCallbackHandler

    handler = VeqenCallbackHandler(feature="research")
    run_id = uuid.uuid4()
    handler.on_chat_model_start({}, [[]], run_id=run_id, metadata={"ls_provider": "anthropic"})
    message = AIMessage(
        content="hi",
        usage_metadata={"input_tokens": 1_500, "output_tokens": 200, "total_tokens": 1_700,
                        "input_token_details": {"cache_read": 1_000, "cache_creation": 0}},
        response_metadata={"model_name": "claude-sonnet-4-5"},
    )
    handler.on_llm_end(LLMResult(generations=[[ChatGeneration(message=message)]]), run_id=run_id)
    [event] = ledger()
    assert (event["provider"], event["input_tokens"], event["cache_read_tokens"], event["feature"]) == (
        "anthropic", 500, 1_000, "research",
    )


def test_langchain_handler_raises_budget_errors_into_the_chain(ledger):
    from veqen.integrations.langchain import VeqenCallbackHandler

    veqen.budget(0, feature="research")
    with pytest.raises(veqen.BudgetExceeded):
        VeqenCallbackHandler(feature="research").on_chat_model_start({}, [[]], run_id=uuid.uuid4())


def test_litellm_callback(ledger):
    from veqen.integrations.litellm import callback

    response = NS(model="gpt-4o", usage=NS(prompt_tokens=100, completion_tokens=50, prompt_tokens_details=None))
    start = datetime(2026, 1, 1)
    callback({"model": "gpt-4o", "litellm_params": {"metadata": {"veqen": {"customer": "acme"}}}}, response,
             start, start + timedelta(milliseconds=420))
    [event] = ledger()
    assert (event["customer"], event["latency_ms"], event["input_tokens"]) == ("acme", 420, 100)


def test_litellm_sends_the_hint_of_the_key_it_used_even_from_the_environment(ledger, monkeypatch):
    from veqen.integrations.litellm import provider_key_hint

    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-api03-abcdefghijklmnop-k9Zq")
    assert provider_key_hint({"api_key": "sk-proj-abcdefghijklmnop1x9Z"}) == "1x9Z"
    assert provider_key_hint({"custom_llm_provider": "anthropic"}) == "k9Zq"
    assert provider_key_hint({"api_key": "os.environ/ANTHROPIC_API_KEY", "custom_llm_provider": "anthropic"}) == "k9Zq"
    assert provider_key_hint({"custom_llm_provider": "groq"}) is None


def test_openai_agents_processor_records_response_and_generation_spans(ledger):
    from veqen.integrations.openai_agents import VeqenTracingProcessor

    processor = VeqenTracingProcessor(feature="agent")
    usage = NS(input_tokens=300, output_tokens=40, input_tokens_details=NS(cached_tokens=100))
    processor.on_span_end(NS(span_data=NS(type="response", response=NS(model="gpt-4o", usage=usage))))
    generation = NS(type="generation", model="gpt-4o", usage={"input_tokens": 10, "output_tokens": 2})
    processor.on_span_end(NS(span_data=generation))
    processor.on_span_end(NS(span_data=NS(type="function")))
    first, second = ledger()
    assert (first["input_tokens"], first["cache_read_tokens"], second["input_tokens"]) == (200, 100, 10)


def test_openai_agents_processor_tags_the_run_with_the_trace(ledger):
    from veqen.integrations.openai_agents import VeqenTracingProcessor

    usage = NS(input_tokens=10, output_tokens=2, input_tokens_details=NS(cached_tokens=0))
    data = NS(type="response", response=NS(model="gpt-4o", usage=usage))
    VeqenTracingProcessor().on_span_end(NS(trace_id="trace_1", span_data=data))
    with veqen.tags(run="mine"):
        VeqenTracingProcessor().on_span_end(NS(trace_id="trace_2", span_data=data))
    assert [e["run"] for e in ledger()] == ["trace_1", "mine"]
