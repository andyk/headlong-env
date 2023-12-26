import { JsosSession } from "@andykon/jsos/src";
import openai from "./openai";
import { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { getJson } from "serpapi";
import api from "api";
import { List as ImmutableList } from "immutable";
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';

//TODO: be more DRY in how we handle types since this
//      is just copy pasted from headlong-vite codebase.
//      Ideally types are stored in (or inferred from)
//      JSOS, which would mean running a program that
//      generates a file with these type definitions 
//      that we would import into this file.
type ThoughtContext = { [key: string]: string };
type Thought = {
    timestamp: Date;
    body: string;
    context: ThoughtContext;
    open_ai_embedding: number[];
};
type ThoughtChangeHistory = Thought[]; // newest first
type ThoughtList = ImmutableList<[Thought, ThoughtChangeHistory]>;

const supabaseUrlEnvName = "SUPABASE_URL_HEADLONG";
const supabaseKeyEnvName = "SUPABASE_SERVICE_ROLE_KEY_HEADLONG";
const openAIMaxTokens = 500;
const openAITemp = 0.5;

const serpApiKeyEnvName = process.env["SERPAPI_API_KEY"];

const pplx = api('@pplx/v0#wqe1glpipk635');
const pplxApiKeyEnvName = "PPLX_API_KEY";
pplx.auth(process.env[pplxApiKeyEnvName]);

const jsos = new JsosSession()
    .addInMemory()
    .addSupabaseFromEnv(supabaseUrlEnvName, supabaseKeyEnvName);

const thoughtsToOpenAIChatMessages = (thoughts: any, systemMsg: string = "") => {
    const messages = thoughts.map(([thought, history]) => ({role: "assistant", content: thought.body}))
    if (systemMsg) {
        return [{role: "system", content: systemMsg}, ...messages];
    }
    return messages;
}

const func: "function" = "function";

// Last thought in the thoughtList is the call to action.
const generateMessages = (thoughtList: ThoughtList) => {
    if (thoughtList === undefined || thoughtList.size === 0) {
        throw("thoughtList must have at least one thought")
    }
    const systemMsg: ChatCompletionMessageParam = {
        role: 'system',
        content: `your job is to consider your recent thoughts and then take an action.
The way you take actions is by calling a function.
If you don't think you know of any funcions that are appropriate for this action, you can say "observation: i don't know how to do that".
When deciding on what action take, use on the following stream of recent thoughts for context:`
    }
    const thoughtListStr = thoughtList.slice(0, thoughtList.size-1).map(([thought, history]) => {
        return thought.body;
    }).join('\n');
    const thoughtListMsg: ChatCompletionMessageParam = {role: "assistant", "content": thoughtListStr}
    const callToActionMsg: ChatCompletionMessageParam = {
        role: "assistant",
        content: `I need to generate a function call that best accomplishes the ${thoughtList.last<[Thought, ThoughtChangeHistory]>()[0].body}`
    }
    console.log("generated messages: ", [systemMsg, thoughtListMsg, callToActionMsg]);
    return [systemMsg, thoughtListMsg, callToActionMsg];
}

const tools = {
    searchGoogle: {
        execute: (args: object, addThought: (thought: string) => void) => {
            getJson({
                api_key: serpApiKeyEnvName,
                engine: "google",
                q: args["query"],
                google_domain: "google.com",
                gl: "us",
                hl: "en",
            }, (json) => {
                const thoughtStr = `observation: search results for query '${args["query"]}': \n\n` + json["organic_results"].slice(0,5).map(result => {
                    return (
                        "title: " + result["title"] + "\n" +
                        "link: " + result["link"] + "\n" + 
                        "snippet: " + result["snippet"]
                    )
                }).join('\n\n')
                addThought(thoughtStr);
            });

        },
        schema: {
            "type": func,
            "function": {
                "name": "searchGoogle",
                "description": "Google search, also known as web search, or just search. use this to look up things",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "the string to search for in google",
                        },
                    },
                    "required": ["query"],
                }
            }
        }
    },
    visitURL: {
        execute: async (args: object, addThought: (thought: string) => void) => {
            const response = await fetch(args["url"]);
            const htmlContent = await response.text();
            const dom = new JSDOM(htmlContent);
            const document = dom.window.document;
        
            const readability = new Readability(document);
            const article = readability.parse();

            addThought(`observation: fetched ${args["url"]}: ` + article);
        },
        schema: {
            "type": func,
            "function": {
                "name": "visitURL",
                "description": "fetch a website. can be in the form of clicking a link",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "url": {
                            "type": "string",
                            "description": "the url to fetch, which might be in the form of a link to click",
                        },
                    },
                    "required": ["url"],
                }
            }
        }

    }
}

const callback = async (newVar) => {
    function addThought(thoughtStr: string) {
        newVar.__jsosUpdate(old => {
            let updated = old.addThought(thoughtStr);
            return updated;
        });
        console.log("Added new thought: ", thoughtStr)
    }
    if (!newVar.pendingActions?.length) {
        return;
    }
    const action = newVar.pendingActions[newVar.pendingActions.length - 1]
    if (!action) {
        return;
    }
    console.log("handling a PendingAction");
    const completion = await openai.chat.completions.create({
        model: "gpt-4-1106-preview",
        messages: generateMessages(newVar.agents.get(action.agentName).thoughts.slice(0, action.thoughtIndex+1)),
        max_tokens:  openAIMaxTokens,
        temperature: openAITemp,
        tools: Object.values(tools).map(tool => tool.schema),
        tool_choice: "auto",
    });

    if (completion.choices[0].message.content) {
        addThought(completion.choices[0].message.content)
        console.log("No functioun called, added thought: ", completion.choices[0].message.content);
    } else if (completion.choices[0].message.tool_calls) {
        console.log(completion.choices[0].message.tool_calls);
        const functionName = completion.choices[0].message.tool_calls[0].function.name;
        const parsedArgs = JSON.parse(completion.choices[0].message.tool_calls[0].function.arguments);
        console.log(`calling ${functionName} with args: ${parsedArgs} `);
        tools[functionName].execute(parsedArgs, addThought);
    }
}
jsos.subscribeToVar({ name: "headlong", namespace: "headlong-vite-v2", callback })

// Listen for SIGTERM signal
process.on('SIGTERM', () => {
    console.log('SIGTERM signal received. Shutting down...');
    // Perform any cleanup operations here
    process.exit(0);
});
