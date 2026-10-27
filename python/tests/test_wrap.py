import asyncio
from types import SimpleNamespace as NS

import pytest

import veqen
from conftest import fake_client
from veqen.client import client


def openai_client(create):
    return fake_client("openai._client", chat=NS(completions=NS(create=create)), models=NS(list=lambda: ["m"]))


def chat_completion(model="gpt-4o-2024-08-06", prompt=1_200, cached=200, completion=300):
    usage = NS(prompt_tokens=prompt, completion_tokens=completion, prompt_tokens_details=NS(cached_tokens=cached))
    return NS(model=model, usage=usage, service_tier="default")


def test_openai_chat_is_priced_and_tagged(ledger):
    wrapped = veqen.wrap(openai_client(lambda **kw: chat_completion()), feature="support")
    with veqen.tags(customer="acme", user="u1"):
        result = wrapped.chat.completions.create(model="gpt-4o", messages=[])
    assert result.model == "gpt-4o-2024-08-06"
    [event] = ledger()
    assert event["provider"] == "openai" and event["model"] == "gpt-4o-2024-08-06"
    assert (event["input_tokens"], event["cache_read_tokens"], event["output_tokens"]) == (1_000, 200, 300)
    assert event["cost_usd"] == pytest.approx((1_000 * 2.5 + 200 * 1.25 + 300 * 10) / 1e6)
    assert (event["customer"], event["feature"], event["user"]) == ("acme", "support", "u1")
    assert wrapped.models.list() == ["m"]  # untouched methods pass through


def test_calls_carry_only_the_last_four_characters_of_the_provider_key(ledger):
    wrapped = veqen.wrap(fake_client("openai._client", api_key="sk-proj-abcdefghijklmnop1x9Z",
                                     chat=NS(completions=NS(create=lambda **kw: chat_completion()))))
    wrapped.chat.completions.create(model="gpt-4o", messages=[])
    veqen.record("gpt-4o", provider="openai", input_tokens=10, provider_key="short")  # too short to be a key: no hint
    veqen.record("gpt-4o", provider="openai", input_tokens=10, provider_key="sk-ant-api03-zzzzzzzzzzzz-Q_7w")
    wrapped_event, short, manual = ledger()
    assert wrapped_event["key_hint"] == "1x9Z" and "key_hint" not in short and manual["key_hint"] == "Q_7w"
    assert "abcdefgh" not in str(wrapped_event)


def test_openai_compatible_hosts_are_priced_as_the_host(ledger):
    together = openai_client(lambda **kw: chat_completion(model="Qwen/Qwen3.5-9B", cached=0))
    together.base_url = "https://api.together.xyz/v1/"
    own = openai_client(lambda **kw: chat_completion(model="llama-3.3-70b", cached=0))
    own.base_url = "http://vllm.internal:8000/v1"
    veqen.wrap(together, project="genomics").chat.completions.create(model="Qwen/Qwen3.5-9B", messages=[])
    veqen.wrap(own, provider="self-hosted").chat.completions.create(model="llama-3.3-70b", messages=[])
    first, second = ledger()
    assert (first["provider"], first["model"], first["project"]) == ("together", "Qwen/Qwen3.5-9B", "genomics")
    expected = veqen.lookup("together/Qwen/Qwen3.5-9B").cost(veqen.pricing.Usage(1_200, 300))
    assert first["cost_usd"] == pytest.approx(expected)
    assert second["provider"] == "self-hosted"


@pytest.mark.parametrize("cls,provider,model", [
    ("AnthropicBedrock", "bedrock", "us.anthropic.claude-sonnet-4-5-20250929-v1:0"),  # a cross-region profile id
    ("AsyncAnthropicBedrock", "bedrock", "anthropic.claude-sonnet-4-5-20250929-v1:0"),
    ("AnthropicVertex", "google", "claude-sonnet-4-5@20250929"),
])
def test_anthropic_on_the_clouds_is_the_clouds_bill(ledger, cls, provider, model):
    message = NS(model=model, usage=NS(input_tokens=100, output_tokens=10))
    client = type(cls, (), {"__module__": "anthropic.lib._client"})()
    client.messages = NS(create=(lambda **kw: message) if not cls.startswith("Async") else _async(message))
    result = veqen.wrap(client).messages.create(model=model, messages=[], max_tokens=10)
    if cls.startswith("Async"):
        import asyncio

        asyncio.run(result)
    [event] = ledger()
    assert event["provider"] == provider
    if provider == "bedrock":  # Bedrock's own rate, under a profile id too
        expected = veqen.lookup("bedrock/anthropic.claude-sonnet-4-5-20250929-v1:0")
        assert expected.provider == "bedrock"
        assert event["cost_usd"] == pytest.approx(expected.cost(veqen.pricing.Usage(100, 10)))


def _async(value):
    async def create(**kw):
        return value
    return create


def test_openrouter_calls_are_openrouters_at_the_labs_list_price(ledger):
    gateway = openai_client(lambda **kw: chat_completion(model="anthropic/claude-sonnet-4.5", cached=0))
    gateway.base_url = "https://openrouter.ai/api/v1"
    veqen.wrap(gateway).chat.completions.create(model="anthropic/claude-sonnet-4.5", messages=[])
    [event] = ledger()
    assert event["provider"] == "openrouter"
    expected = veqen.lookup("anthropic/claude-sonnet-4-5").cost(veqen.pricing.Usage(1_200, 300))
    assert event["cost_usd"] == pytest.approx(expected)


def test_azure_openai_calls_are_azures_at_openai_prices(ledger):
    azure = openai_client(lambda **kw: chat_completion(model="gpt-4o", cached=0))
    azure.base_url = "https://acme-east.openai.azure.com/openai/v1/"
    veqen.wrap(azure).chat.completions.create(model="gpt-4o", messages=[])
    [event] = ledger()
    assert event["provider"] == "azure-ai"
    assert event["cost_usd"] == pytest.approx(veqen.lookup("openai/gpt-4o").cost(veqen.pricing.Usage(1_200, 300)))


def test_openai_images_audio_and_embeddings(ledger):
    images = NS(generate=lambda **kw: NS(data=[1, 2]),
                edit=lambda **kw: NS(data=[1], usage=NS(input_tokens=500, output_tokens=4_000)))
    audio = NS(speech=NS(create=lambda **kw: b"mp3"),
               transcriptions=NS(create=lambda **kw: NS(text="hi", usage=NS(type="duration", seconds=90))),
               translations=NS(create=lambda **kw: NS(text="hi", duration=30.0)))
    usage = NS(prompt_tokens=8_000, total_tokens=8_000)
    embeddings = NS(create=lambda **kw: NS(model="text-embedding-3-small", usage=usage))
    wrapped = veqen.wrap(fake_client("openai._client", images=images, audio=audio, embeddings=embeddings))
    wrapped.images.generate(model="gpt-image-1", prompt="a cat", n=2, size="1024x1024", quality="high")
    wrapped.images.edit(model="gpt-image-1", image=b"", prompt="hat")
    wrapped.audio.speech.create(model="tts-1", input="Hello there", voice="alloy")
    wrapped.audio.transcriptions.create(model="whisper-1", file=b"")
    wrapped.audio.translations.create(model="whisper-1", file=b"")
    wrapped.embeddings.create(model="text-embedding-3-small", input=["x"])
    gen, edit, speech, transcript, translation, embed = ledger()
    assert (gen["units"], gen["variant"]) == (2, "high/1024x1024")
    assert gen["cost_usd"] == pytest.approx(2 * veqen.lookup("gpt-image-1").unit_rate("high/1024x1024"))
    assert (edit["input_tokens"], edit["output_tokens"], edit["units"]) == (500, 4_000, 1)
    assert speech["units"] == 11 and speech["cost_usd"] == pytest.approx(11 * 15 / 1e6)
    assert transcript["units"] == 90 and transcript["cost_usd"] == pytest.approx(0.009)
    assert translation["units"] == 30
    assert embed["input_tokens"] == 8_000 and embed["cost_usd"] == pytest.approx(8_000 * 0.02 / 1e6)


def test_calls_that_report_only_a_cost_keep_it(ledger):
    veqen.record("fal-ai/flux/dev", provider="fal", cost_usd=0.07, feature="thumbnails")
    veqen.record("veo-3.1-generate-001", provider="google", units=8, variant="1080p", project="ads")
    veqen.record("gpt-4o-mini", provider="unknown", input_tokens=10, output_tokens=5)
    reported, video, unstated = ledger()
    assert unstated["provider"] == "openai"
    assert reported["cost_usd"] == pytest.approx(0.07)
    assert video["cost_usd"] == pytest.approx(veqen.cost("veo-3.1-generate-001", units=8, variant="1080p"))
    assert (video["variant"], video["project"]) == ("1080p", "ads")


def test_openai_stream_requests_usage_and_records_once_at_the_end(ledger):
    seen = {}

    def create(**kwargs):
        seen.update(kwargs)
        return iter([NS(model="gpt-4o", usage=None), NS(model="gpt-4o", usage=chat_completion().usage)])

    chunks = list(veqen.wrap(openai_client(create)).chat.completions.create(model="gpt-4o", stream=True))
    assert len(chunks) == 2 and seen["stream_options"] == {"include_usage": True}
    assert len(ledger()) == 1


def test_stream_without_usage_records_nothing(ledger):
    stream = veqen.wrap(openai_client(lambda **kw: iter([NS(model="gpt-4o", usage=None)])))
    list(stream.chat.completions.create(model="gpt-4o", stream=True))
    assert ledger() == []


def test_anthropic_stream_combines_start_and_final_delta(ledger):
    start_usage = NS(input_tokens=100, output_tokens=1, cache_read_input_tokens=1_000, cache_creation_input_tokens=0)
    events = [
        NS(type="message_start", message=NS(model="claude-sonnet-4-5", usage=start_usage)),
        NS(type="content_block_delta"),
        NS(type="message_delta", usage=NS(output_tokens=250)),
    ]
    anthropic = fake_client("anthropic._client", messages=NS(create=lambda **kw: iter(events)))
    list(veqen.wrap(anthropic).messages.create(model="claude-sonnet-4-5", stream=True))
    [event] = ledger()
    assert (event["input_tokens"], event["cache_read_tokens"], event["output_tokens"]) == (100, 1_000, 250)


def test_anthropic_one_hour_cache_writes_are_split_out(ledger):
    usage = NS(input_tokens=10, output_tokens=5, cache_read_input_tokens=0, cache_creation_input_tokens=3_000,
               cache_creation=NS(ephemeral_1h_input_tokens=1_000), service_tier="standard")
    message = NS(model="claude-sonnet-4-5", usage=usage)
    anthropic = fake_client("anthropic._client", messages=NS(create=lambda **kw: message))
    veqen.wrap(anthropic, residency="us").messages.create(model="claude-sonnet-4-5")
    [event] = ledger()
    assert (event["cache_write_tokens"], event["cache_write_1h_tokens"], event["residency"]) == (2_000, 1_000, "us")


def test_stream_helper_records_the_final_message(ledger):
    final = NS(model="claude-sonnet-4-5", usage=NS(input_tokens=40, output_tokens=60, cache_read_input_tokens=0,
                                                   cache_creation_input_tokens=0))

    class Manager:
        def __enter__(self):
            return NS(get_final_message=lambda: final)

        def __exit__(self, *exc):
            return False

    anthropic = fake_client("anthropic._client", messages=NS(stream=lambda **kw: Manager()))
    with veqen.wrap(anthropic).messages.stream(model="claude-sonnet-4-5") as stream:
        assert stream.get_final_message() is final
    assert ledger()[0]["output_tokens"] == 60


def test_google_async_generate_content(ledger):
    async def generate_content(**kwargs):
        meta = NS(prompt_token_count=500, cached_content_token_count=100, candidates_token_count=40,
                  thoughts_token_count=20)
        return NS(model_version="gemini-2.5-flash", usage_metadata=meta)

    google = fake_client("google.genai.client", aio=NS(models=NS(generate_content=generate_content)))
    asyncio.run(veqen.wrap(google).aio.models.generate_content(model="gemini-2.5-flash", contents="hi"))
    [event] = ledger()
    assert (event["provider"], event["input_tokens"], event["cache_read_tokens"], event["output_tokens"]) == (
        "google", 400, 100, 60,
    )


def test_unpriced_reported_model_falls_back_to_the_requested_one(ledger):
    wrapped = veqen.wrap(openai_client(lambda **kw: chat_completion(model="my-deployment")))
    wrapped.chat.completions.create(model="gpt-4o", messages=[])
    assert ledger()[0]["model"] == "gpt-4o"


def test_block_budget_stops_the_call_before_it_is_made(ledger):
    calls = []
    wrapped = veqen.wrap(openai_client(lambda **kw: calls.append(1) or chat_completion()))
    veqen.budget(0.001, customer="*")
    with veqen.tags(customer="acme"):
        wrapped.chat.completions.create(model="gpt-4o", messages=[])
        with pytest.raises(veqen.BudgetExceeded) as exc:
            wrapped.chat.completions.create(model="gpt-4o", messages=[])
    with veqen.tags(customer="other"):
        wrapped.chat.completions.create(model="gpt-4o", messages=[])
    assert len(calls) == 2 and exc.value.value == "acme"


def test_wrap_rejects_unknown_clients():
    with pytest.raises(TypeError):
        veqen.wrap(object())


def test_cloud_mode_sends_json_batches_and_enforces_shared_budgets(server):
    veqen.init(api_key="vq_live_test", endpoint=server.url, budget_poll=0)
    veqen.record("gpt-4o", input_tokens=10, output_tokens=5, customer="acme")
    assert veqen.flush(5)
    assert server.events[0]["customer"] == "acme" and server.headers[0]["Authorization"] == "Bearer vq_live_test"
    assert "Content-Encoding" not in server.headers[0]
    server.blocked.append({"scope": "customer", "value": "acme", "limit_usd": 5.0})
    client._poll_budgets()
    with pytest.raises(veqen.BudgetExceeded), veqen.tags(customer="acme"):
        client.check(veqen.current_tags())


def test_recording_problems_never_break_the_call(tmp_path, caplog, monkeypatch):
    blocker = tmp_path / "file"
    blocker.write_text("")
    veqen.init(ledger_file=str(blocker / "ledger.jsonl"))  # its folder can't be created
    monkeypatch.setattr(client, "record", lambda *a, **k: 1 / 0)
    wrapped = veqen.wrap(openai_client(lambda **kw: chat_completion()))
    result = wrapped.chat.completions.create(model="gpt-4o", messages=[])
    assert result.model == "gpt-4o-2024-08-06"
    assert "couldn't record" in caplog.text and "ledger folder" in caplog.text


def test_warn_budgets_log_once_and_never_block(ledger, caplog):
    wrapped = veqen.wrap(openai_client(lambda **kw: chat_completion()))
    veqen.budget(0.001, mode="warn")
    for _ in range(3):
        wrapped.chat.completions.create(model="gpt-4o", messages=[])
    assert len(ledger()) == 3 and caplog.text.count("budget reached") == 1


def test_cloud_batches_fit_edge_limit_without_losing_unicode_events(server):
    from veqen.client import _Client

    sender = _Client()
    sender.api_key = "vq_live_test"
    sender.endpoint = server.url
    events = [{"id": str(i), "tags": {"note": "🧪" * 600}} for i in range(80)]
    sender.queue.extend(events)
    sender._send()
    assert list(sender.queue) == []
    assert server.events == events
    assert len(server.bodies) > 1
    assert all(len(body) <= 64 * 1024 for body in server.bodies)
    assert all("Content-Encoding" not in header for header in server.headers)


def test_oversized_event_does_not_block_later_events(server, caplog):
    from veqen.client import _Client

    sender = _Client()
    sender.api_key = "vq_live_test"
    sender.endpoint = server.url
    sender.queue.extend([{"id": "too-large", "tags": {"note": "x" * 65536}}, {"id": "valid"}])
    sender._send()
    assert server.events == [{"id": "valid"}]
    assert not sender.queue
    assert "64 KiB" in caplog.text
