import { Agent, run, tool, user, type AgentInputItem } from "@openai/agents";
import {
  appSpecSchema,
  changeProposalSchema,
  type AppSpec,
  type ChangeProposal,
} from "@/lib/spec";

/**
 * Planning conversation agent (Stage 1).
 * Covers the Intake + Clarifier + Product Spec roles from the VoiceForge spec:
 * understands the idea, asks non-technical questions, then records a
 * structured spec via the propose_spec tool. Approval is handled outside
 * the model, by a real button and a database row.
 */

const PLANNER_MODEL = process.env.OPENAI_PLANNER_MODEL ?? "gpt-5.4-mini";

const PLANNER_INSTRUCTIONS = `You are VoiceForge, a friendly assistant that helps non-technical people plan an app they want built. The person you are talking to is a family member or friend of the owner — never assume technical knowledge.

Your job in this conversation:
1. Understand what app they want (their first message is the idea).
2. Ask clarifying questions in plain, everyday language — things like: Who will use it? What should people be able to do? Should information be saved? Should everyone share one list or have their own? Do you want photos, search, charts, or AI features? Ask at most TWO short questions per message. Keep the whole conversation to around 3-5 rounds of questions — do not interrogate.
3. Suggest a friendly app name and check they like it.
4. When you have enough to plan the app, call the propose_spec tool exactly once with the complete specification.
5. After the tool call succeeds, present the plan back to the user as a short, plain-English summary with these sections: App name, What it does, Main screens, What you can do, What gets saved, How sharing works, and What we'll test. End by telling them to press the Approve button below if they want it built, or to tell you what to change.

Rules:
- Never discuss code, databases, frameworks, or hosting — translate everything into everyday language.
- If the user asks for something unsafe, illegal, or that handles other people's money or medical decisions, politely decline and suggest a safer alternative.
- If the user wants changes after you proposed a spec, discuss them and call propose_spec again with the revised specification.
- Keep every reply short and warm. One idea at a time.`;

export type PlannerResult = {
  reply: string;
  history: AgentInputItem[];
  /** Set when the model recorded a (new) spec this turn. */
  proposal: AppSpec | null;
};

export async function runPlanner(
  history: AgentInputItem[],
  userMessage: string,
): Promise<PlannerResult> {
  let proposal: AppSpec | null = null;

  const proposeSpec = tool({
    name: "propose_spec",
    description:
      "Record the final app specification. Call this exactly once, after the user has answered your clarifying questions and agreed on an app name.",
    parameters: appSpecSchema,
    execute: async (spec: AppSpec) => {
      proposal = spec;
      return "Specification recorded. Now summarize the plan for the user in plain English and ask them to press the Approve button.";
    },
  });

  const agent = new Agent({
    name: "VoiceForge Planner",
    model: PLANNER_MODEL,
    instructions: PLANNER_INSTRUCTIONS,
    tools: [proposeSpec],
  });

  const input: AgentInputItem[] = [...history, user(userMessage)];
  const result = await run(agent, input, { maxTurns: 6 });

  return {
    reply: extractReply(result.output) || fallbackReply(result.finalOutput),
    history: result.history,
    proposal,
  };
}

export type ChangePlannerResult = {
  reply: string;
  history: AgentInputItem[];
  proposal: ChangeProposal | null;
};

const CHANGE_INSTRUCTIONS_TEMPLATE = `You are VoiceForge, helping a non-technical person change an app they already built with you. Never assume technical knowledge.

The app's CURRENT specification is:
__CURRENT_SPEC__

Your job:
1. Understand what they want changed (their first message describes it).
2. Ask a few short clarifying questions in everyday language — at most TWO per message, around 1-3 rounds total. Only ask about the change; don't re-plan the whole app.
3. When you understand the change, call the propose_change tool exactly once with the COMPLETE UPDATED specification (the current spec with the change applied — keep everything else as it is) plus a changeSummary describing what's different.
4. After the tool succeeds, summarize in plain English: what will change, what stays the same, and any new things that will be saved or tested. End by telling them to press the Approve button, or to tell you what to adjust.

Rules:
- Never discuss code or technical details.
- Keep the app's name unless the user asks to change it.
- If the user asks for something unsafe or that handles other people's money or medical decisions, politely decline and suggest a safer alternative.
- If they want adjustments after proposing, discuss and call propose_change again with the revised spec.
- Keep every reply short and warm.`;

export async function runChangePlanner(
  history: AgentInputItem[],
  userMessage: string,
  currentSpec: AppSpec,
): Promise<ChangePlannerResult> {
  let proposal: ChangeProposal | null = null;

  const proposeChange = tool({
    name: "propose_change",
    description:
      "Record the complete updated app specification plus a plain-language summary of the change. Call exactly once, after the user has answered your clarifying questions.",
    parameters: changeProposalSchema,
    execute: async (change: ChangeProposal) => {
      proposal = change;
      return "Change recorded. Now summarize what will change for the user and ask them to press the Approve button.";
    },
  });

  const agent = new Agent({
    name: "VoiceForge Change Planner",
    model: PLANNER_MODEL,
    instructions: CHANGE_INSTRUCTIONS_TEMPLATE.replace(
      "__CURRENT_SPEC__",
      JSON.stringify(currentSpec, null, 2),
    ),
    tools: [proposeChange],
  });

  const input: AgentInputItem[] = [...history, user(userMessage)];
  const result = await run(agent, input, { maxTurns: 6 });

  return {
    reply: extractReply(result.output) || fallbackReply(result.finalOutput),
    history: result.history,
    proposal,
  };
}

/**
 * Collect every non-empty assistant text from the run output.
 * Newer reasoning models emit their user-facing text in a "commentary"
 * phase message followed by an empty "final_answer" message, so
 * result.finalOutput (which reads only the last message) can be empty.
 */
function extractReply(output: unknown[]): string {
  const parts: string[] = [];
  for (const item of output) {
    const msg = item as {
      type?: string;
      role?: string;
      content?: Array<{ type?: string; text?: string }>;
    };
    if (msg.type === "message" && msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const c of msg.content) {
        if (c.type === "output_text" && c.text?.trim()) {
          parts.push(c.text.trim());
        }
      }
    }
  }
  return parts.join("\n\n");
}

function fallbackReply(finalOutput: unknown): string {
  return typeof finalOutput === "string" ? finalOutput : "";
}
