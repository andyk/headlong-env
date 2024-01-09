# Headlong Env
Headlong Env is a daemon that provides actuation and sensory input for a [Headlong agent](https://github.com/andyk/headlong-vite). Operates by listening to the headlong [JSOS Var](https://github.com/andyk/jsos), executing actions, and updating the headlong var with observations.

# Install & Run
```
npm install
npm run bashServer  # A service that provides an API for a multi-tab terminal emulator - default port is 3031
npm run env  # An env that subscribes to a JSOS Variable and calls functions in response to "action: ..." thoughts.
```
