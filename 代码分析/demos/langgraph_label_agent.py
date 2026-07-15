"""Minimal LangGraph label-analysis agent.

The LLM only plans and selects tools. Domain rules live in the system prompt,
while tools provide deterministic, structured log-analysis results.
"""

from typing import Any

from langchain.chat_models import init_chat_model
from langchain.tools import tool
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import SystemMessage
from langgraph.graph import END, START, MessagesState, StateGraph
from langgraph.prebuilt import ToolNode, tools_condition


@tool
def analyze_with_tool_a(log: str) -> dict[str, Any]:
    """Extract the fields required by analysis step A from an NPU compiler log."""
    # Demo data. Replace this body with the real deterministic log parser.
    return {"key1": 42, "key2": 18, "key3": 1}


@tool
def analyze_with_tool_b(log: str) -> dict[str, Any]:
    """Extract the fields required by analysis step B from an NPU compiler log."""
    # Demo data. Replace this body with the real deterministic log parser.
    return {"score": 92, "fatal_count": 0}


# The real project can register 40+ reusable tools here. Clear names,
# descriptions, argument schemas, and structured outputs are important.
ALL_TOOLS = [
    analyze_with_tool_a,
    analyze_with_tool_b,
]


BASE_SYSTEM_PROMPT = """
You are an NPU compiler log label-analysis agent.

You do not analyze raw logs from memory and must not invent evidence. Follow
the expert playbook exactly and base every decision on structured tool output.

Target label: {label_id}

Expert playbook:
{playbook}

The final response must be JSON only:
{{
  "label_id": "{label_id}",
  "matched": true | false,
  "failed_at": "tool or step name" | null,
  "evidence": object,
  "reason": "short explanation"
}}
""".strip()


# These are trusted playbooks. In production they can live in JSON/YAML, a
# database, or an MCP Resource. The user supplies label_id, not prompt text.
LABEL_PLAYBOOKS: dict[str, str] = {
    "label_alpha": """
1. Call `analyze_with_tool_a` first.
2. result1 passes only when key1 < 50, key2 > 10, and key3 != 0.
3. If result1 fails, return matched=false and do not call B.
4. If result1 passes, call `analyze_with_tool_b`.
5. result2 passes only when score >= 80 and fatal_count == 0.
6. Return matched=true only when both result1 and result2 pass.
""".strip(),
    "label_beta": """
1. Call `analyze_with_tool_b`.
2. The result passes only when score >= 90 and fatal_count == 0.
3. Return matched=true when it passes; otherwise return matched=false.
""".strip(),
}


class LabelAgentState(MessagesState):
    label_id: str


def render_system_prompt(label_id: str) -> str:
    playbook = LABEL_PLAYBOOKS.get(label_id)
    if playbook is None:
        available = ", ".join(sorted(LABEL_PLAYBOOKS))
        raise ValueError(f"Unknown label_id {label_id!r}. Available labels: {available}")
    return BASE_SYSTEM_PROMPT.format(label_id=label_id, playbook=playbook)


def build_label_agent(model: BaseChatModel):
    """Build the Agent -> Tools -> Agent ReAct loop."""
    model_with_tools = model.bind_tools(ALL_TOOLS)

    async def call_agent(state: LabelAgentState):
        system_prompt = render_system_prompt(state["label_id"])
        response = await model_with_tools.ainvoke(
            [SystemMessage(content=system_prompt), *state["messages"]]
        )
        return {"messages": [response]}

    builder = StateGraph(LabelAgentState)
    builder.add_node("agent", call_agent)
    builder.add_node("tools", ToolNode(ALL_TOOLS, handle_tool_errors=True))

    builder.add_edge(START, "agent")
    # A tool call routes to "tools"; a normal assistant response routes to END.
    builder.add_conditional_edges(
        "agent",
        tools_condition,
        {
            "tools": "tools", 
            "__end__": END
        },
    )
    builder.add_edge("tools", "agent")

    return builder.compile()


async def analyze_label(agent, label_id: str, log: str) -> str:
    result = await agent.ainvoke(
        {
            # The graph loads and injects the corresponding trusted playbook.
            "label_id": label_id,
            "messages": [
                {
                    "role": "user",
                    "content": f"Analyze this log for the target label:\n{log}",
                }
            ]
        },
        # Prevent an accidental infinite Agent/Tool loop.
        {"recursion_limit": 10},
    )
    return str(result["messages"][-1].content)


async def main() -> None:
    # Replace this model identifier with the provider/model used by the project.
    model = init_chat_model("openai:gpt-4.1-mini", temperature=0)
    agent = build_label_agent(model)

    log = "<compiler log>"
    print(await analyze_label(agent, "label_alpha", log))
    print(await analyze_label(agent, "label_beta", log))


if __name__ == "__main__":
    import asyncio

    asyncio.run(main())
