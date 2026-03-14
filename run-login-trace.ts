import { startBrowserAgent, closeTraceLogger } from "./packages/magnitude-core/src/index";
import { z } from "./packages/magnitude-core/node_modules/zod";

const agent = await startBrowserAgent({
    url: "https://juice.bugbase.ai",
    narrate: true,
    llm: {
        provider: 'anthropic',
        options: {
            model: 'claude-sonnet-4-20250514',
            apiKey: process.env.ANTHROPIC_API_KEY,
            promptCaching: true,
        }
    },
});

try {
    // 1. CreatePartialRecipe — the planner loop
    await agent.act("Navigate to the login page and attempt to log in with email 'test@example.com' and password 'password123'");

    // 2. ExtractData — structured extraction from the page
    const extracted = await agent.extract(
        "Extract the error message displayed on the login page and the current URL",
        z.object({
            errorMessage: z.string(),
            currentUrl: z.string(),
        })
    );
    console.log("\n[EXTRACT RESULT]", extracted);

    // 3. QueryMemory — query against the agent's memory/context
    const queryResult = await agent.query(
        "Did the login attempt succeed or fail? What evidence do you see?",
        z.object({
            loginSucceeded: z.boolean(),
            evidence: z.string(),
        })
    );
    console.log("\n[QUERY RESULT]", queryResult);

} catch (err) {
    console.error("Agent error:", err);
} finally {
    await agent.stop();
    closeTraceLogger();
    console.log("\n[DONE] Check the magnitude-trace-*.jsonl files in the current directory for full LLM traces.");
}
