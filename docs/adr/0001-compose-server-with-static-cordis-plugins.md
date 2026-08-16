# Compose EV Server with static Cordis plugins

Status: accepted

EV Server is the product kernel behind the Desktop, Mobile, and CLI clients. We will compose Server capabilities as built-in Cordis plugins, using an exact upstream Cordis version; a minimal bootstrap owns the root `Context`, startup, and shutdown, while tasks, runtimes, persistence, browser integration, management, and transports move behind deep Service interfaces with plugin-owned lifecycle.

## Consequences

- The first tracer bullet converts the existing Runtime seam without changing client contracts or Runtime behavior.
- Plugins are statically imported trusted code. EV does not enable Cordis Loader, HMR, plugin-directory discovery, runtime npm installation, or Renderer-provided module paths.
- Desktop, Mobile, CLI, Browser Host, and Browser Extension do not load Cordis plugins.
- EV depends on upstream `cordis` pinned to one exact version; it does not import DSH's vendored `@deepseek-ai/cordis`.
- A plugin is a lifecycle and composition unit around a deep Service, not a wrapper around every function or class.

## Rejected alternatives

We rejected an EV-specific plugin framework because it would duplicate Cordis lifecycle and dependency semantics. We also rejected expanding only the existing registries because that would leave startup, cleanup, service dependencies, and health as unrelated mechanisms. Dynamic third-party plugins remain outside this decision because in-process plugin code has full Server privileges.
