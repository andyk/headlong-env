import { spawn } from 'child_process';
import net from 'net';
import { maybeMultipartFormRequestOptions } from 'openai/uploads';

const bashServerPort = Number(process.env.BASH_SERVER_PORT) || 3031;

interface Env {
    shells: {
        [id: string]: {
            proc: any,
            history: string
        }
    };
    activeShellID: string | null;
}

const env: Env = {
    shells: {},
    activeShellID: null
};

const server = net.createServer();

server.on('connection', (socket) => {
    console.log('bashServer: client connected')
    // Relay messages from the socket to the subprocess
    socket.on('data', (data) => {
        console.log("received: ", data.toString());
        const msg = JSON.parse(data.toString());
        const { type, payload = {} } = msg;
        if (type === 'openNewShell') {
            const {
                shellID = undefined,
                shellPath = "/bin/bash",
                shellArgs = []
            } = payload;
            const id = shellID ? shellID : "shell-" + Math.random().toString(36).substring(7)
            const augmentedShellArgs = [
                '--rcfile',
                './.bashrc',
                ...shellArgs,
                "-i"
            ]
            console.log("calling spawn with: ", shellPath, augmentedShellArgs)
            env.shells[id] = {
                proc: spawn(
                    `${shellPath}`,
                    augmentedShellArgs,
                    { stdio: [ 'pipe', 'pipe', 'pipe', 'ipc' ] }
                ),
                history: ''
            };
            env.activeShellID = id;
            env.shells[id].proc.stdin?.write('\n');
            socket.write(`observation: created and shell with ID ${id} and made it the active shell.`)

            // Relay messages from the subprocess to the socket
            env.shells[id].proc.stdout?.on('data', (data) => {
                socket.write(`observation: shell ${id}:\n` + data);
            });
            env.shells[id].proc.stderr?.on('data', (data) => {
                socket.write(`observation: shell ${id}:\n` + data);
            });
            env.shells[id].proc.on('exit', (data) => {
                socket.write(`observation: shell '${id}' exited.`);
            });
            env.shells[id].proc.on('close', (signal) => {
                socket.write(`observation: shell '${id}' terminated due to receipt of signal ${signal}`);
            });
        } else if (type === 'runCommand') {
            if (env.activeShellID === null) {
                socket.write("observation: there are no shells open")
            } else {
                const { command } = payload;
                env.shells[env.activeShellID].proc.stdin?.write(command);
            }
        } else if (type === 'switchToShell') {
            const { id } = payload;
            if (!(payload.id in env.shells)) {
                socket.write(`observation: can't find shell with ID '${id}'`)
                return;
            }
            env.activeShellID = id;
            socket.write(`observation: switched to shell '${id}`)
        } else {
            console.log("received unrecognized type from client: ", type);
        }
    });

});

server.listen(bashServerPort, () => {
  console.log(`bashServer listening on port ${bashServerPort}`);
});

// Listen for SIGTERM signal
process.on('SIGTERM', () => {
    console.log('SIGTERM signal received. Shutting down...');
    // Perform any cleanup operations here
    process.exit(0);
});