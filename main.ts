import { JsosSession } from "@andykon/jsos/src";
import openai from "./openai";
import { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { getJson } from "serpapi";
import api from "api";
import { List as ImmutableList } from "immutable";
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import twilioSDK from 'twilio';
import net from 'net';

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

const bashServerPort = Number(process.env.BASH_SERVER_PORT) || 3031;

const supabaseUrlEnvName = "SUPABASE_URL_HEADLONG";
const supabaseKeyEnvName = "SUPABASE_SERVICE_ROLE_KEY_HEADLONG";
const openAIMaxTokens = 500;
const openAITemp = 0.5;

const serpApiKeyEnvName = process.env["SERPAPI_API_KEY"];

const pplx = api('@pplx/v0#wqe1glpipk635');
const pplxApiKeyEnvName = "PPLX_API_KEY";
pplx.auth(process.env[pplxApiKeyEnvName]);

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioPhoneNumber = process.env.TWILIO_PHONE_NUMBER;
const twilioClient = twilioSDK(accountSid, authToken);


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

const client = net.createConnection({ port: bashServerPort }, () => {
    console.log('connected to bashServer on port ', bashServerPort);
});

client.on('end', () => {
    console.log('disconnected from server');
});

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
    console.log("generated messages: ", [
        systemMsg,
        {role: "assistant", content: "..." + thoughtListStr.slice(-200)},
        callToActionMsg
    ]);
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
            "type": 'function' as 'function',
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

            if (article?.textContent) {
                addThought(`observation: fetched ${args["url"]}: ` + article.textContent);
            }
        },
        schema: {
            "type": 'function' as 'function',
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
    },
    newShell: {
        execute: async (args: object, addThought: (thought: string) => void) => {
            client.write(
                JSON.stringify({
                    type: "newShell",
                    payload: {
                        shellID: args["shellID"],
                        shellPath: args["shellPath"],
                        shellArgs: args["shellArgs"]
                    }
                })
            );
        },
        schema: {
            "type": 'function' as 'function',
            "function": {
                "name": "newShell",
                "description": "create a new shell",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "shellBinary": {
                            "type": "string",
                            "default": "/bin/bash",
                            "description": "path of shell binary, e.g. /bin/bash"
                        },
                        "shellArgs": {
                            "type": "array",
                            "items": {
                                "type": "string"
                            },
                            "description": "arguments to pass to the shell binary"
                        },
                        "shellID": {
                            "type": "string",
                            "description": "unique ID for the new shell"
                        },
                    },
                }
            }
        }
    },
    switchToShell: {
        execute: async (args: object, addThought: (thought: string) => void) => {
            client.write(
                JSON.stringify({
                    type: "switchToShell",
                    payload: {id: args["id"]}
                })
            );
        },
        schema: {
            "type": 'function' as 'function',
            "function": {
                "name": "switchToShell",
                "description": "switch to the specified shell, i.e. 'bring it to the front'",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "id": {
                            "type": "string",
                            "description": "the ID of the shell to switch to"
                        },
                    },
                }
            }
        }
    },
    executeShellCommand: {
        execute: async (args: object, addThought: (thought: string) => void) => {
            client.write(
                JSON.stringify({
                    type: "runCommand",
                    payload: {command: args["command"]}
                })
            );
        },
        schema: {
            "type": 'function' as 'function',
            "function": {
                "name": "executeShellCommand",
                "description": "run a command in the currently active shell",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": {
                            "type": "string",
                            "description": "the shell command to execute in the active shell"
                        },
                    },
                }
            }
        }
    },
    sendText: {
        execute: async (args: object, addThought: (thought: string) => void) => {
            if (args["to"] !== "+15103567082") {
                console.log("For now, we don't allow text anybody other than Andy");
                return;
            }
            twilioClient.messages.create({
                body: args["body"],
                from: twilioPhoneNumber,
                to: args["to"],
            }).then(message => console.log(message.sid));
        },
        schema: {
            "type": 'function' as 'function',
            "function": {
                "name": "sendText",
                "description": "send a text message to a phone number",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "body": {
                            "type": "string",
                            "description": "the message to send"
                        },
                        "to": {
                            "type": "string",
                            "description": "the phone number to send the message to"
                        },
                    },
                }
            }
        }
    },
    checkTime: {
        execute: async (args: object, addThought: (thought: string) => void) => {
            const now = new Date();
            const timeOptions = {
                timeZone: args["timezone"] || 'America/Los_Angeles',
                year: 'numeric' as 'numeric',
                month: 'long' as 'long',
                day: 'numeric' as 'numeric',
                weekday: 'long' as 'long',
                hour: '2-digit' as '2-digit',
                minute: '2-digit' as '2-digit',
                second: '2-digit' as '2-digit',
                hour12: true
            };
            const timeInPT = now.toLocaleString('en-US', timeOptions);
            addThought("observation: it's " + timeInPT);
        },
        schema: {
            "type": 'function' as 'function',
            "function": {
                "name": "checkTime",
                "description": "see what time it is, could be looking my watch or a clock",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "timezone": {
                            "type": "string",
                            "description": "the timezone. default is 'America/Los_Angeles'"
                        },
                    },
                }
            }
        }
    }
}

let headlongVar;

function addThought(thoughtStr: string) {
    if (!headlongVar) {
        return;
    }
    headlongVar.__jsosUpdate(old => {
        let updated = old.addThought(thoughtStr);
        return updated;
    }).then(() => {
        console.log("Added new thought: ", thoughtStr)
    }).catch((e) => {
        //if (e.name !== "VarUpdateConflictError") {
        //    console.log("Failed to add thought. error: ", e);
        //    return;
        //}
        console.log("Failed to add thought. using __jsosPull and retrying. error: ", e);
        headlongVar.__jsosPull().then((pulledVar) => {
            pulledVar.__jsosUpdate(old => {
                let updated = old.addThought(thoughtStr);
                return updated;
            }).catch((etwo) => {
                console.log("Failed to add thought again. error: ", etwo)
            });
        });
    });
}

client.on('data', (data) => {
    console.log(data.toString());
    addThought(data.toString());
});

const callback = async (newVar) => {
    headlongVar = newVar;
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
        console.log(`calling ${functionName} with args: ${JSON.stringify(parsedArgs)} `);
        tools[functionName].execute(parsedArgs, addThought);
    }
}
console.log("subscribed to var. sub id: ", jsos.subscribeToVar({ name: "headlong", namespace: "headlong-vite-v2", callback }))

console.log("registered tools:\n", Object.keys(tools).join("\n"));
// TODO: Register any env listeners that would async interrupt "observations: "
// (or other thoughts?) into consciouness

// Listen for SIGTERM signal
process.on('SIGTERM', () => {
    console.log('SIGTERM signal received. Shutting down...');
    // Perform any cleanup operations here
    process.exit(0);
});
