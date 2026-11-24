# AXIOM Studio for Windows

Open AXIOM-Studio.exe on Windows x64 with .NET Framework 4.8. To rebuild the executable, run AXIOM-Studio-build.ps1 from PowerShell.

- Open a workspace to browse its text files. Double-click a file to edit it. Ctrl+S saves.
- The Git toolbar shows status, the diff from HEAD, and recent commits. Commit changes records tracked changes. Stage new files manually in the command panel. Git for Windows must be on PATH.
- The terminal panel runs explicit, non-interactive Windows commands in the selected workspace and reports the output and exit code.
- AI chat supports a configurable chat-completions endpoint. Set AXIOM_AI_ENDPOINT to the full endpoint URL, AXIOM_AI_MODEL to your provider's model ID, and AXIOM_AI_KEY if the provider requires authentication. Launch the app from the environment where those variables are set. It sends messages entered in chat, including recent chat history.

The Windows development build is unsigned.

