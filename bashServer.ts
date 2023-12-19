import { spawn } from 'child_process';
import net from 'net';

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
  // Relay messages from the socket to the subprocess
  socket.on('data', (data) => {
    const msg = JSON.parse(data.toString());
    const { type, payload } = msg;
    if (type === 'openNewShell') {
        const { id, shellPath, shellArgs } = payload;
        env.shells[id] = {
            proc: spawn(`PS1="> " ${shellPath || "/bin/bash"}`, [...shellArgs, "-i"], {
                stdio: [ 'pipe', 'pipe', 'pipe', 'ipc' ]
            }),
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
        env.shells[id].proc..on('close', (signal) => {
            socket.write(`observation: shell '${id}' terminated due to receipt of signal ${signal}`);
        });
    }
    if (type === 'runCommand') {
        if (env.activeShellID === null) {
            socket.write("observation: there are no shells open")
        } else {
            const { command } = payload;
            env.shells[env.activeShellID].proc.stdin?.write(command);
        }
    }
    if (type === 'switchToShell') {
        const { id } = payload;
        if (!(payload.id in env.shells)) {
            socket.write(`observation: can't find shell with ID '${id}'`)
            return;
        }
        env.activeShellID = id;
        socket.write(`observation: switched to shell '${id}`)
    }
  });

});

server.listen(3031, () => {
  console.log('Server listening on port 3000');
});
