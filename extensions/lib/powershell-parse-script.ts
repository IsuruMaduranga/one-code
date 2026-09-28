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

# Command lookup must never load or run a module: autoloading is off, and the
# built-in modules the gate's cmdlets live in are imported from $PSHOME by
# path, so a same-named module earlier on PSModulePath cannot stand in. The
# walker only reports what a name resolves to (type, module, path); the gate
# enforces which of those it trusts (powershell-tree.ts).
$PSModuleAutoLoadingPreference = 'None'
foreach ($module in 'Microsoft.PowerShell.Management', 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Security') {
	$manifest = "$PSHOME/Modules/$module"
	if ([System.IO.Directory]::Exists($manifest)) { try { Import-Module -Name $manifest } catch {} }
}
$binderType = 'System.Management.Automation.Language.StaticParameterBinder' -as [type]

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
		$asts = New-Object System.Collections.ArrayList
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
			[void]$asts.Add($node)
		}
		# Second pass, once every node has its index: what each static command
		# name resolves to in this PowerShell, and for a cmdlet how PowerShell's
		# own binder assigns its arguments to parameters.
		for ($i = 0; $i -lt $nodes.Count; $i++) {
			if ($nodes[$i].type -ne 'CommandAst' -or $null -eq $nodes[$i].name) { continue }
			$command = $asts[$i]
			$info = $null
			try { $info = $ExecutionContext.InvokeCommand.GetCommand($nodes[$i].name, 'All') } catch {}
			if ($null -eq $info) { continue }
			if ($info -is [System.Management.Automation.AliasInfo]) {
				$nodes[$i].alias = $true
				$info = $info.ResolvedCommand
				if ($null -eq $info) { continue }
			}
			$nodes[$i].commandType = [string]$info.CommandType
			$nodes[$i].resolvedName = $info.Name
			if ($info -is [System.Management.Automation.ApplicationInfo]) { $nodes[$i].resolvedName = $info.Path }
			$nodes[$i].module = [string]$info.ModuleName
			if ($info -isnot [System.Management.Automation.CmdletInfo]) { continue }
			if ($null -eq $binderType) { $nodes[$i].bindingUnavailable = $true; continue }
			try {
				# Windows PowerShell 5.1's binder does not follow an alias to its
				# cmdlet, so an aliased command is bound as a copy spelled with the
				# cmdlet's name, and each bound value is mapped back by extent.
				$bindAst = $command
				$origin = 0
				$nameEnd = 0
				$delta = 0
				if ($nodes[$i].alias) {
					$nameExtent = $command.CommandElements[0].Extent
					$relative = $nameExtent.StartOffset - $command.Extent.StartOffset
					$text = $command.Extent.Text
					$copy = $text.Substring(0, $relative) + $info.Name + $text.Substring($relative + $nameExtent.Text.Length)
					$bindAst = [System.Management.Automation.Language.Parser]::ParseInput($copy, [ref]$null, [ref]$null).Find({ param($n) $n -is [System.Management.Automation.Language.CommandAst] }, $false)
					$origin = $command.Extent.StartOffset
					$nameEnd = $relative + $info.Name.Length
					$delta = $info.Name.Length - $nameExtent.Text.Length
				}
				# The node of the original command a bound value stands for, or -1:
				# the value itself, or the node with the same (mapped) extent and type.
				# The binder builds values of its own for a remaining-arguments
				# parameter (Write-Output a b: an array of copies).
				$original = {
					param($ast)
					if ([object]::ReferenceEquals($bindAst, $command) -and $index.ContainsKey($ast)) { return $index[$ast] }
					$start = $ast.Extent.StartOffset
					$end = $ast.Extent.EndOffset
					if (-not [object]::ReferenceEquals($bindAst, $command)) {
						if ($start -ge $nameEnd) { $start -= $delta }
						if ($end -ge $nameEnd) { $end -= $delta }
						$start += $origin
						$end += $origin
					}
					$type = $ast.GetType().Name
					for ($j = $i + 1; $j -lt $nodes.Count -and $nodes[$j].start -lt $command.Extent.EndOffset; $j++) {
						if ($nodes[$j].start -eq $start -and $nodes[$j].end -eq $end -and $nodes[$j].type -eq $type) { return $j }
					}
					return -1
				}
				$bound = $binderType::BindCommand($bindAst, $true)
				$nodes[$i].bindings = @(foreach ($key in $bound.BoundParameters.Keys) {
					$result = $bound.BoundParameters[$key]
					$record = @{ parameter = [string]$key; value = -1 }
					if ($null -ne $result.Value) {
						$record.value = & $original $result.Value
						# -2 marks a value the binder built: its elements, if an array,
						# are mapped one by one.
						if ($record.value -lt 0) {
							$record.value = -2
							if ($result.Value -is [System.Management.Automation.Language.ArrayLiteralAst]) {
								$record.elements = @(foreach ($element in $result.Value.Elements) { & $original $element })
							}
						}
					}
					$record
				})
				$nodes[$i].bindingErrors = @(foreach ($key in $bound.BindingExceptions.Keys) { [string]$key })
			} catch {
				$nodes[$i].bindingUnavailable = $true
			}
		}
		Send-Record @{ id = $id; nodes = @($nodes); errors = @($parseErrors | ForEach-Object { $_.ErrorId }) }
	} catch {
		Send-Record @{ id = $id; failure = $_.Exception.Message }
	}
}
`;
