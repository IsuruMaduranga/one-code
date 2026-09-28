/**
 * The PowerShell side of the parse server (lib/powershell-parser.ts): a short
 * bootstrap passed on the command line, and the walker script it reads from
 * stdin and runs.
 *
 * The walker calls PowerShell's own `Parser::ParseInput` on each request and
 * writes back every syntax-tree node, so the gate judges the line exactly as
 * the PowerShell that runs it reads it (decisions/windows.md "The PowerShell
 * pre-gate reads PowerShell's own parse"). All judgement stays in TypeScript;
 * the walker only reports.
 *
 * Wire protocol, one line each way, ASCII only because every payload is
 * base64: Windows PowerShell 5.1 reads and writes its console in the OEM code
 * page, which would garble exactly the Unicode dashes and quotes a gate must
 * see.
 *
 * - The first stdin line is the walker script (base64 UTF-8). The walker
 *   answers with a ready record, id 0: `{ id, ready, edition, version, language }`.
 * - Each later stdin line is `<id> <base64 UTF-8 command>`. The walker answers
 *   `{ id, nodes, errors }`, or `{ id, failure }` when the walk itself threw.
 * - Each stdout line is base64 UTF-8 JSON. EOF on stdin ends the walker.
 *
 * `nodes` is the tree in pre-order, root first. Each node carries its .NET
 * type name, its parent's index (-1 for the root), its extent as UTF-16
 * offsets into the command (the same units as a JS string index), and a few
 * fields for the types a gate reads (see `nodeFields`). `errors` lists each
 * parse error's ErrorId; PowerShell runs nothing from a line that has one.
 *
 * Pure: two string constants, no pi imports, shared with the BI fork.
 */

/**
 * Passed after `-Command`. It reads the first stdin line and runs it as the
 * walker. It holds no double quote, so no platform's argument quoting can
 * change it.
 */
export const POWERSHELL_PARSE_BOOTSTRAP =
	"$s=[Console]::In.ReadLine();if($null -ne $s){. ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($s))))}";

/** The walker, sent as the first stdin line. Plain ASCII; no backtick, so it survives a template literal unchanged. */
export const POWERSHELL_PARSE_WALKER = String.raw`
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding $false
$out = [Console]::Out

function Send-Record($record) {
	$json = ConvertTo-Json -InputObject $record -Depth 5 -Compress
	$out.WriteLine([Convert]::ToBase64String($utf8.GetBytes($json)))
	$out.Flush()
}

function Get-NodeFields($node) {
	$f = @{}
	switch ($node.GetType().Name) {
		'CommandAst' { $f.operator = [string]$node.InvocationOperator; $f.name = $node.GetCommandName() }
		'CommandParameterAst' { $f.name = $node.ParameterName }
		'StringConstantExpressionAst' { $f.value = $node.Value; $f.kind = [string]$node.StringConstantType }
		'ExpandableStringExpressionAst' { $f.value = $node.Value; $f.kind = [string]$node.StringConstantType }
		'ConstantExpressionAst' { $f.value = [string]$node.Value }
		'VariableExpressionAst' { $f.name = $node.VariablePath.UserPath; $f.splatted = $node.Splatted }
		'FileRedirectionAst' { $f.from = [string]$node.FromStream; $f.append = $node.Append }
		'MergingRedirectionAst' { $f.from = [string]$node.FromStream; $f.to = [string]$node.ToStream }
		'BinaryExpressionAst' { $f.operator = [string]$node.Operator }
		'UnaryExpressionAst' { $f.operator = [string]$node.TokenKind }
		'AssignmentStatementAst' { $f.operator = [string]$node.Operator }
		'PipelineChainAst' { $f.operator = [string]$node.Operator; $f.background = $node.Background }
		'PipelineAst' { if ($node.PSObject.Properties['Background']) { $f.background = $node.Background } }
		'TypeExpressionAst' { $f.name = $node.TypeName.FullName }
		'TypeConstraintAst' { $f.name = $node.TypeName.FullName }
		'MemberExpressionAst' { $f.static = $node.Static }
		'InvokeMemberExpressionAst' { $f.static = $node.Static }
	}
	$f
}

Send-Record @{
	id = 0
	ready = $true
	edition = [string]$PSVersionTable.PSEdition
	version = [string]$PSVersionTable.PSVersion
	language = [string]$ExecutionContext.SessionState.LanguageMode
}

while ($null -ne ($line = [Console]::In.ReadLine())) {
	$space = $line.IndexOf(' ')
	if ($space -lt 1) { continue }
	$id = [int]$line.Substring(0, $space)
	try {
		$command = $utf8.GetString([Convert]::FromBase64String($line.Substring($space + 1)))
		$tokens = $null
		$parseErrors = $null
		$ast = [System.Management.Automation.Language.Parser]::ParseInput($command, [ref]$tokens, [ref]$parseErrors)
		$all = @($ast.FindAll({ $true }, $true))
		$index = New-Object 'System.Collections.Generic.Dictionary[System.Object,int]'
		$nodes = New-Object System.Collections.ArrayList
		foreach ($node in $all) {
			if ($index.ContainsKey($node)) { continue }
			$parent = -1
			if ($null -ne $node.Parent -and $index.ContainsKey($node.Parent)) { $parent = $index[$node.Parent] }
			$record = Get-NodeFields $node
			$record.type = $node.GetType().Name
			$record.parent = $parent
			$record.start = $node.Extent.StartOffset
			$record.end = $node.Extent.EndOffset
			$index[$node] = $nodes.Count
			[void]$nodes.Add($record)
		}
		Send-Record @{ id = $id; nodes = @($nodes); errors = @($parseErrors | ForEach-Object { $_.ErrorId }) }
	} catch {
		Send-Record @{ id = $id; failure = $_.Exception.Message }
	}
}
`;
