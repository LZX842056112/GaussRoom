# NOTE: this file is deliberately ASCII-only.
# Windows PowerShell 5.1 reads .ps1 files as ANSI unless they carry a UTF-8 BOM,
# so a non-ASCII literal here breaks the parser ("string is missing the
# terminator"). The localized dialog title is passed in via -Title instead.
# Output encoding is forced to UTF-8 so paths containing non-ASCII characters
# survive the trip back to Node, which decodes stdout as UTF-8.
param([string]$Title = "Select image folder")

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = $Title
$dialog.ShowNewFolderButton = $false

if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.Write($dialog.SelectedPath)
}
