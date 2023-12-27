import net from 'net';
import readline from 'readline';

const bashServerPort = Number(process.env.BASH_SERVER_PORT) || 3031;

const client = net.createConnection({ port: bashServerPort }, () => {
    console.log('connected to bashServer on port ', bashServerPort);
});

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

client.on('data', (data) => {
    console.log('testBashServer received data: ', data.toString());
});

function askQuestion() {
    rl.question('Enter command type and args (JSON format):\n', (input) => {
        try {
            const parsedInput = JSON.parse(input);
            client.write(JSON.stringify(parsedInput));
            console.log("wrote to bashServer: ", JSON.stringify(parsedInput));
        } catch(e) {
            console.log("error parsing input and sending it to bashServer: ", e);
        }
        askQuestion();
    });
}

askQuestion();

// Listen for SIGTERM signal
process.on('SIGTERM', () => {
    console.log('SIGTERM signal received. Shutting down...');
    // Perform any cleanup operations here
    process.exit(0);
});
