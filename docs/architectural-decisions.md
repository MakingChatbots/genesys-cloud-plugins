# Architecture

The plugin consists of Skills and an MCP server.

## Using Architect Scripting SDK

After [experimenting with Archy and defining flows as YAML](https://www.linkedin.com/posts/lucas-woodward-the-dev_claudecode-genesys-genesyscloud-share-7459998571816218624-9OvS/?utm_source=share&utm_medium=member_desktop&rcm=ACoAABsbo2wBcmnNqxYJ5UO9BrsfURZcVEtgLOU)
I found two big issues:

* There is no YAML specification that would allow me to catch incorrect flow definitions without the slow process of deploying
* The references within the YAML are hard to maintain across large flows

I decided to instead use [Architect Scripting SDK](https://mypurecloud.github.io/purecloud-flow-scripting-api-sdk-javascript/)
since it allows:

* Flows to be defined in code - something Claude Code is great at
* The SDK contains TypeScript types, which can be used to quickly test for correctness. This is quicker than using a deployment for feedback on correctness.

There are some downsides though:

* Using this SDK requires Claude Code to install NPM dependencies (Architect Scripting SDK, TypeScript)
* Not everyone is comfortable with code
* It can only manage flows that are defined using Architect Scripting SDK. You cannot point it at an existing flow.