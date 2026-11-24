using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Forms;
using System.Web.Script.Serialization;

internal sealed class Axiom : Form
{
    readonly TreeView tree = new TreeView();
    readonly RichTextBox editor = new RichTextBox();
    readonly RichTextBox results = new RichTextBox();
    readonly TextBox command = new TextBox();
    readonly TextBox prompt = new TextBox();
    readonly List<Dictionary<string, string>> conversation = new List<Dictionary<string, string>>();
    readonly Label status = new Label();
    readonly TabControl tools = new TabControl();
    string workspace, file;
    bool dirty, loading, commandRunning, aiRunning;
    Encoding fileEncoding = new UTF8Encoding(false);
    string lineEnding = Environment.NewLine;

    [STAThread]
    static void Main(string[] args)
    {
        if (args.Length == 1 && args[0] == "--self-test")
        {
            var input = new Dictionary<string, string> { { "role", "user" }, { "content", "hello" } };
            var json = new JavaScriptSerializer();
            if (!json.Serialize(input).Contains("hello") ||
                ReadReply(json, "{\"choices\":[{\"message\":{\"content\":\"world\"}}]}") != "world") Environment.ExitCode = 1;
            using (var form = new Axiom()) { if (form.tools.TabPages.Count != 2) Environment.ExitCode = 1; }
            return;
        }
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new Axiom());
    }

    Axiom()
    {
        Text = "AXIOM Studio";
        MinimumSize = new Size(780, 540);
        Size = new Size(1210, 790);
        Font = new Font("Segoe UI", 10);
        BackColor = Color.FromArgb(239, 244, 250);
        StartPosition = FormStartPosition.CenterScreen;
        var toolbar = new FlowLayoutPanel { Dock = DockStyle.Top, Height = 56, Padding = new Padding(10), BackColor = Color.FromArgb(20, 36, 60) };
        AddButton(toolbar, "Open workspace", OpenWorkspace);
        AddButton(toolbar, "Open file", OpenFile);
        AddButton(toolbar, "Save", delegate { Save(); });
        AddButton(toolbar, "Git status", async delegate { await RunGit("status --short --branch"); });
        AddButton(toolbar, "Git diff", async delegate { await RunGit("diff --no-ext-diff HEAD"); });
        AddButton(toolbar, "Git log", async delegate { await RunGit("log -15 --oneline --decorate"); });
        AddButton(toolbar, "Commit changes", async delegate { await Commit(); });

        status.Dock = DockStyle.Bottom;
        status.Height = 29;
        status.Padding = new Padding(10, 5, 0, 0);
        status.Text = "Open a workspace or a text file.";
        var columns = new SplitContainer { Dock = DockStyle.Fill, Size = new Size(1180, 680), SplitterDistance = 230 };
        tree.Dock = DockStyle.Fill;
        tree.BorderStyle = BorderStyle.None;
        tree.BeforeExpand += delegate(object sender, TreeViewCancelEventArgs e) { LoadDirectory(e.Node); };
        tree.NodeMouseDoubleClick += delegate(object sender, TreeNodeMouseClickEventArgs e)
        {
            string path = e.Node.Tag as string;
            if (path != null && File.Exists(path)) LoadFile(path);
        };
        columns.Panel1.Controls.Add(tree);
        var work = new SplitContainer { Dock = DockStyle.Fill, Orientation = Orientation.Horizontal, Size = new Size(900, 650), SplitterDistance = 400 };
        ConfigureText(editor, false);
        editor.AcceptsTab = true;
        editor.TextChanged += delegate { if (!loading) { dirty = true; UpdateTitle(); } };
        work.Panel1.Controls.Add(editor);
        tools.Dock = DockStyle.Fill;
        var terminal = new TabPage("Terminal and Git");
        var chat = new TabPage("AI chat");
        tools.TabPages.Add(terminal);
        tools.TabPages.Add(chat);
        ConfigureText(results, true);
        var terminalBottom = new TableLayoutPanel { Dock = DockStyle.Bottom, Height = 36, ColumnCount = 2 };
        terminalBottom.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        terminalBottom.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        command.Dock = DockStyle.Fill;
        terminalBottom.Controls.Add(command, 0, 0);
        var run = new Button { Text = "Run command", AutoSize = true };
        run.Click += async delegate { await RunCommand(); };
        terminalBottom.Controls.Add(run, 1, 0);
        command.KeyDown += async delegate(object sender, KeyEventArgs e)
        {
            if (e.KeyCode != Keys.Enter) return;
            e.SuppressKeyPress = true;
            await RunCommand();
        };
        terminal.Controls.Add(results);
        terminal.Controls.Add(terminalBottom);
        var transcript = new RichTextBox();
        ConfigureText(transcript, true);
        var chatBottom = new TableLayoutPanel { Dock = DockStyle.Bottom, Height = 67, ColumnCount = 2 };
        chatBottom.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        chatBottom.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        prompt.Multiline = true;
        prompt.Dock = DockStyle.Fill;
        chatBottom.Controls.Add(prompt, 0, 0);
        var send = new Button { Text = "Send", AutoSize = true };
        send.Click += async delegate { await SendPrompt(transcript); };
        chatBottom.Controls.Add(send, 1, 0);
        chat.Controls.Add(transcript);
        chat.Controls.Add(chatBottom);
        transcript.Text = "Set AXIOM_AI_ENDPOINT, AXIOM_AI_MODEL and, if needed, AXIOM_AI_KEY. The chat sends only messages you submit.";
        work.Panel2.Controls.Add(tools);
        columns.Panel2.Controls.Add(work);
        Controls.Add(columns);
        Controls.Add(status);
        Controls.Add(toolbar);
        KeyPreview = true;
        KeyDown += delegate(object sender, KeyEventArgs e)
        {
            if (e.Control && e.KeyCode == Keys.S) { e.SuppressKeyPress = true; Save(); }
            if (e.Control && e.KeyCode == Keys.O) { e.SuppressKeyPress = true; OpenFile(); }
        };
        FormClosing += delegate(object sender, FormClosingEventArgs e) { e.Cancel = !CanLeaveFile(); };
    }

    static void ConfigureText(RichTextBox box, bool readOnly)
    {
        box.Dock = DockStyle.Fill;
        box.BorderStyle = BorderStyle.None;
        box.Font = new Font("Consolas", 11);
        box.WordWrap = false;
        box.DetectUrls = false;
        box.ReadOnly = readOnly;
        box.BackColor = readOnly ? Color.FromArgb(245, 248, 253) : Color.White;
        box.ForeColor = Color.FromArgb(25, 42, 67);
    }

    static void AddButton(FlowLayoutPanel panel, string label, Action action)
    {
        var button = new Button { Text = label, AutoSize = true, Height = 33, ForeColor = Color.White, FlatStyle = FlatStyle.Flat };
        button.FlatAppearance.BorderColor = Color.FromArgb(102, 127, 156);
        button.Click += delegate { action(); };
        panel.Controls.Add(button);
    }

    void OpenWorkspace()
    {
        using (var dialog = new FolderBrowserDialog())
        {
            if (dialog.ShowDialog(this) != DialogResult.OK) return;
            workspace = dialog.SelectedPath;
            tree.Nodes.Clear();
            var root = new TreeNode(workspace) { Tag = workspace };
            root.Nodes.Add(new TreeNode());
            tree.Nodes.Add(root);
            root.Expand();
            status.Text = workspace;
        }
    }

    void LoadDirectory(TreeNode node)
    {
        if (node.Nodes.Count != 1 || node.Nodes[0].Tag != null) return;
        node.Nodes.Clear();
        string path = (string)node.Tag;
        try
        {
            foreach (var item in new DirectoryInfo(path).EnumerateFileSystemInfos())
            {
                if (item.Name == ".git" || item.Name == "node_modules" || (item.Attributes & FileAttributes.ReparsePoint) != 0) continue;
                var child = new TreeNode(item.Name) { Tag = item.FullName };
                if (item is DirectoryInfo) child.Nodes.Add(new TreeNode());
                node.Nodes.Add(child);
            }
        }
        catch (Exception error) { status.Text = error.Message; }
    }

    void OpenFile()
    {
        using (var dialog = new OpenFileDialog()) if (dialog.ShowDialog(this) == DialogResult.OK) LoadFile(dialog.FileName);
    }

    bool CanLeaveFile()
    {
        if (!dirty) return true;
        var choice = MessageBox.Show(this, "Save the current file before continuing?", "Unsaved changes", MessageBoxButtons.YesNoCancel);
        return choice == DialogResult.No || (choice == DialogResult.Yes && Save());
    }

    void LoadFile(string path)
    {
        if (!CanLeaveFile()) return;
        try
        {
            if (new FileInfo(path).Length > 4 * 1024 * 1024) throw new IOException("The editor supports text files up to 4 MB.");
            string text;
            using (var reader = new StreamReader(path, new UTF8Encoding(false, true), true))
            {
                text = reader.ReadToEnd();
                if (text.IndexOf('\0') >= 0) throw new IOException("This file is not plain text.");
                fileEncoding = reader.CurrentEncoding;
                lineEnding = text.Contains("\r\n") ? "\r\n" : text.Contains("\n") ? "\n" : Environment.NewLine;
            }
            loading = true;
            editor.Text = text;
            file = path;
            dirty = false;
            status.Text = file;
            UpdateTitle();
        }
        catch (Exception error) { status.Text = error.Message; }
        finally { loading = false; }
    }

    bool Save()
    {
        string path = file;
        if (path == null)
        {
            using (var dialog = new SaveFileDialog())
            {
                if (dialog.ShowDialog(this) != DialogResult.OK) return false;
                path = dialog.FileName;
            }
        }
        string temporary = Path.Combine(Path.GetDirectoryName(path), ".axiom-" + Guid.NewGuid().ToString("N") + ".tmp");
        try
        {
            File.WriteAllText(temporary, editor.Text.Replace("\r\n", "\n").Replace("\n", lineEnding), fileEncoding);
            if (File.Exists(path)) File.Replace(temporary, path, null);
            else File.Move(temporary, path);
            file = path;
            dirty = false;
            status.Text = "Saved " + Path.GetFileName(file);
            UpdateTitle();
            return true;
        }
        catch (Exception error) { status.Text = "Save failed: " + error.Message; return false; }
        finally { if (File.Exists(temporary)) { try { File.Delete(temporary); } catch (IOException) {} catch (UnauthorizedAccessException) {} } }
    }

    void UpdateTitle()
    {
        Text = (file == null ? "Untitled" : Path.GetFileName(file)) + (dirty ? " *" : "") + " | AXIOM Studio";
    }

    async Task RunCommand()
    {
        string value = command.Text.Trim();
        if (value.Length == 0 || commandRunning) return;
        command.Clear();
        await Execute("cmd.exe", "/d /c " + value, value);
    }

    Task RunGit(string arguments)
    {
        if (workspace == null) { status.Text = "Open the Git repository folder first."; return Task.FromResult(-1); }
        return Execute("git.exe", arguments, "git " + arguments);
    }

    async Task Commit()
    {
        if (workspace == null || commandRunning) return;
        using (var dialog = new Form { Text = "Commit tracked changes", Width = 510, Height = 165, StartPosition = FormStartPosition.CenterParent })
        {
            var message = new TextBox { Dock = DockStyle.Top };
            var confirm = new Button { Text = "Commit all tracked changes", Dock = DockStyle.Bottom, DialogResult = DialogResult.OK };
            dialog.Controls.Add(confirm);
            dialog.Controls.Add(message);
            dialog.AcceptButton = confirm;
            if (dialog.ShowDialog(this) != DialogResult.OK || string.IsNullOrWhiteSpace(message.Text)) return;
            string path = Path.GetTempFileName();
            try
            {
                File.WriteAllText(path, message.Text, new UTF8Encoding(false));
                await RunGit("commit -a -F \"" + path + "\"");
            }
            catch (Exception error) { status.Text = error.Message; }
            finally { File.Delete(path); }
        }
    }

    async Task<int> Execute(string program, string arguments, string display)
    {
        if (commandRunning) return -1;
        commandRunning = true;
        tools.SelectedIndex = 0;
        results.AppendText("\r\n> " + display + "\r\n");
        string target = workspace ?? (file == null ? Environment.GetFolderPath(Environment.SpecialFolder.UserProfile) : Path.GetDirectoryName(file));
        try
        {
            return await Task.Run(async delegate
            {
                using (var process = new Process())
                {
                    process.StartInfo = new ProcessStartInfo(program, arguments)
                    {
                        WorkingDirectory = target, UseShellExecute = false, CreateNoWindow = true,
                        RedirectStandardOutput = true, RedirectStandardError = true, RedirectStandardInput = true
                    };
                    process.Start();
                    process.StandardInput.Close();
                    var output = process.StandardOutput.ReadToEndAsync();
                    var errors = process.StandardError.ReadToEndAsync();
                    await Task.WhenAll(output, errors);
                    process.WaitForExit();
                    int code = process.ExitCode;
                    if (!IsDisposed && IsHandleCreated)
                        BeginInvoke((Action)delegate { results.AppendText(output.Result + errors.Result + "\r\nExit code " + code + "\r\n"); });
                    return code;
                }
            });
        }
        catch (Exception error) { results.AppendText(error.Message + "\r\n"); return -1; }
        finally { commandRunning = false; }
    }

    static string ReadReply(JavaScriptSerializer json, string response)
    {
        var body = json.Deserialize<Dictionary<string, object>>(response);
        var choices = (System.Collections.IList)body["choices"];
        var choice = (Dictionary<string, object>)choices[0];
        return (string)((Dictionary<string, object>)choice["message"])["content"];
    }

    async Task SendPrompt(RichTextBox transcript)
    {
        string message = prompt.Text.Trim();
        if (aiRunning || message.Length == 0) return;
        string address = Environment.GetEnvironmentVariable("AXIOM_AI_ENDPOINT");
        string model = Environment.GetEnvironmentVariable("AXIOM_AI_MODEL");
        string key = Environment.GetEnvironmentVariable("AXIOM_AI_KEY");
        Uri endpoint;
        if (!Uri.TryCreate(address, UriKind.Absolute, out endpoint) || string.IsNullOrWhiteSpace(model) ||
            (endpoint.Scheme != "https" && !(endpoint.Scheme == "http" && endpoint.IsLoopback)))
        {
            transcript.AppendText("\r\nConfigure a full HTTPS chat completions endpoint and a model. HTTP is supported on loopback.");
            return;
        }
        aiRunning = true;
        prompt.Clear();
        transcript.AppendText("\r\n\r\nYou: " + message + "\r\n");
        var pending = new Dictionary<string, string> { { "role", "user" }, { "content", message } };
        conversation.Add(pending);
        try
        {
            var json = new JavaScriptSerializer();
            byte[] payload = Encoding.UTF8.GetBytes(json.Serialize(new { model = model, messages = conversation }));
            var request = (HttpWebRequest)WebRequest.Create(endpoint);
            request.Method = "POST";
            request.ContentType = "application/json";
            request.AllowAutoRedirect = false;
            if (!string.IsNullOrEmpty(key)) request.Headers["Authorization"] = "Bearer " + key;
            using (var timeout = new System.Threading.Timer(delegate { request.Abort(); }, null, 60000, System.Threading.Timeout.Infinite))
            {
                using (var stream = await request.GetRequestStreamAsync()) await stream.WriteAsync(payload, 0, payload.Length);
                using (var response = await request.GetResponseAsync())
                using (var reader = new StreamReader(response.GetResponseStream()))
                {
                    var reply = ReadReply(json, await reader.ReadToEndAsync());
                    conversation.Add(new Dictionary<string, string> { { "role", "assistant" }, { "content", reply } });
                    if (conversation.Count > 20) conversation.RemoveRange(0, 2);
                    transcript.AppendText("AXIOM: " + reply + "\r\n");
                }
            }
        }
        catch (Exception error)
        {
            conversation.Remove(pending);
            prompt.Text = message;
            transcript.AppendText("Request failed: " + error.Message + "\r\n");
        }
        finally { aiRunning = false; }
    }
}

