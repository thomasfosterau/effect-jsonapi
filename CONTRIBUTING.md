# Contributing to effect-jsonapi

Thank you for your interest in contributing to effect-jsonapi! This document provides guidelines and instructions for contributing.

## Development Setup

### Prerequisites

- Node.js 18.x or higher
- npm or yarn

### Getting Started

1. Fork the repository
2. Clone your fork:
   ```bash
   git clone https://github.com/YOUR_USERNAME/effect-jsonapi.git
   cd effect-jsonapi
   ```

3. Install dependencies:
   ```bash
   npm install
   ```

4. Build the project:
   ```bash
   npm run build
   ```

5. Run tests:
   ```bash
   npm test
   ```

## Development Workflow

### Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch
```

### Building

```bash
npm run build
```

### Running Examples

```bash
npm run example
```

## Code Style

- Use TypeScript for all code
- Follow the existing code style
- Use Effect's functional programming patterns
- Add JSDoc comments for public APIs
- Keep functions pure and composable

## Testing

- Write tests for all new features
- Ensure all tests pass before submitting a PR
- Use vitest for testing
- Follow the existing test structure in `src/__tests__/`

## Commit Messages

- Use clear and descriptive commit messages
- Start with a verb in present tense (e.g., "Add", "Fix", "Update")
- Reference issue numbers when applicable

## Pull Request Process

1. Create a new branch for your feature/fix:
   ```bash
   git checkout -b feature/my-new-feature
   ```

2. Make your changes and commit them with clear messages

3. Push to your fork:
   ```bash
   git push origin feature/my-new-feature
   ```

4. Create a Pull Request from your fork to the main repository

5. Ensure your PR:
   - Has a clear description of the changes
   - Includes tests for new functionality
   - Passes all existing tests
   - Follows the code style guidelines
   - Updates documentation if needed

## Reporting Issues

When reporting issues, please include:

- A clear description of the problem
- Steps to reproduce the issue
- Expected behavior
- Actual behavior
- Environment details (Node.js version, OS, etc.)
- Relevant code samples or error messages

## Feature Requests

Feature requests are welcome! Please:

- Check if the feature has already been requested
- Provide a clear use case
- Explain how it aligns with JSON:API specification
- Consider how it fits with Effect's patterns

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
