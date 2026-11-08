# NOTE: this file is deliberately ASCII-only.
# Windows PowerShell 5.1 reads .ps1 files as ANSI unless they carry a UTF-8 BOM,
# so a non-ASCII literal here breaks the parser. Titles and filters are passed in
# from Node instead. Output encoding is forced to UTF-8 so paths containing
# non-ASCII characters survive the trip back to Node.
param(
  [string]$Title = "Select files",
  [string]$Filter = "All files|*.*"
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = $Title
$dialog.Filter = $Filter
$dialog.Multiselect = $true
$dialog.CheckFileExists = $true
$dialog.CheckPathExists = $true

if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  foreach ($path in $dialog.FileNames) { [Console]::Out.WriteLine($path) }
}
