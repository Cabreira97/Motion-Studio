# Contributing to Motion Studio

Thanks for your interest! Bug reports, ideas and pull requests are all welcome.

## Reporting bugs and requesting features

Open an [issue](https://github.com/Cabreira97/Motion-Studio/issues/new/choose)
using one of the templates. For bugs, include your OS, how you installed or ran
the app, and the steps to reproduce.

## Submitting changes

`main` is protected: nobody pushes to it directly, and every change lands
through a reviewed pull request.

1. Fork the repository and create a branch from `main`.
2. Set up the project — see the Quick start in the [README](README.md).
3. Make your change, keeping it focused on one thing.
4. Make sure these pass:

   ```bash
   pnpm typecheck
   pnpm test
   ```

5. Open a pull request against `main` describing what changed and why.

A maintainer will review it; once approved and all conversations are resolved,
it gets merged.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
