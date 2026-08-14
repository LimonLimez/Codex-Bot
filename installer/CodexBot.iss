#define AppCanonicalVersion "0.1.4"
#define AppPublisher "Codex Bot contributors"
#define AppURL "https://github.com/LimonLimez/Codex-Bot"
#define DevelopmentBuild GetEnv("CODEX_BOT_INSTALLER_DEVELOPMENT")
#define VendorVersion "0.18.0"
#define VendorInstallerName "Grok_Bot_0.18.0_Setup.exe"
#define VendorInstallerURL "https://downloads.cursor.com/grokbot/stable/win32-x64/0.18.0/Grok_Bot_0.18.0_Setup.exe"
#define VendorInstallerSHA256 "464079A15EF5FA8B61CCEA8FFFCC78F63CFCF6DF65FB0AD5E725D8B95F7E437E"
#define VendorInstallerSize "125825552"

#if DevelopmentBuild == "1"
  #define AppName "Codex Bot DEVELOPMENT TEST BUILD"
  #define AppVersion "0.1.4 DEVELOPMENT TEST BUILD"
  #define AppOutputBaseFilename GetEnv("CODEX_BOT_INSTALLER_OUTPUT_BASENAME")
  #define AppVersionInfoDescription "Codex Bot DEVELOPMENT TEST installer - DO NOT PUBLISH"
  #define AppVersionInfoProductName "Codex Bot DEVELOPMENT TEST BUILD"
#else
  #define AppName "Codex Bot"
  #define AppVersion "0.1.4"
  #define AppOutputBaseFilename "CodexBot-Setup-0.1.4"
  #define AppVersionInfoDescription "Codex Bot installer"
  #define AppVersionInfoProductName "Codex Bot"
#endif

[Setup]
AppId={{E76F3A8B-12D0-4F6C-9C73-C11881446E1B}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
AppSupportURL=https://github.com/LimonLimez/Codex-Bot/issues
AppUpdatesURL=https://github.com/LimonLimez/Codex-Bot/releases
DefaultDirName={localappdata}\Programs\Codex Bot
DefaultGroupName=Codex Bot
DisableProgramGroupPage=yes
OutputDir=..\artifacts
OutputBaseFilename={#AppOutputBaseFilename}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
RedirectionGuard=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayName=Codex Bot
CloseApplications=yes
RestartApplications=no
VersionInfoVersion={#AppCanonicalVersion}.0
VersionInfoCompany={#AppPublisher}
VersionInfoDescription={#AppVersionInfoDescription}
VersionInfoProductName={#AppVersionInfoProductName}
SetupIconFile=..\assets\codex-bot.ico
UninstallDisplayIcon={app}\app\Codex Bot.exe

[Files]
Source: "..\src\bridge.cjs"; DestDir: "{app}\tools\src"; Flags: ignoreversion
Source: "..\src\codex-connection.cjs"; DestDir: "{app}\tools\src"; Flags: ignoreversion
Source: "..\src\browser-seat-bridge.cjs"; DestDir: "{app}\tools\src"; Flags: ignoreversion
Source: "..\src\official-computer-client.cjs"; DestDir: "{app}\tools\src"; Flags: ignoreversion
Source: "..\src\official-computer-helper.cjs"; DestDir: "{app}\tools\src"; Flags: ignoreversion
Source: "..\src\browser-seats\browser-seat-manager.cjs"; DestDir: "{app}\tools\src\browser-seats"; Flags: ignoreversion
Source: "..\src\browser-seats\public-web-proxy.cjs"; DestDir: "{app}\tools\src\browser-seats"; Flags: ignoreversion
Source: "..\src\browser-seats\browser-action-approval.cjs"; DestDir: "{app}\tools\src\browser-seats"; Flags: ignoreversion
Source: "..\src\browser-seats\browser-control-lease.cjs"; DestDir: "{app}\tools\src\browser-seats"; Flags: ignoreversion
Source: "..\src\browser-seats\browser-page-hardening.cjs"; DestDir: "{app}\tools\src\browser-seats"; Flags: ignoreversion
Source: "..\src\renderer\codex-ui.js"; DestDir: "{app}\tools\src\renderer"; Flags: ignoreversion
Source: "..\src\renderer\live-seat-component.jsfrag"; DestDir: "{app}\tools\src\renderer"; Flags: ignoreversion
Source: "..\src\runtime\Launch-Codex-Bot.ps1"; DestDir: "{app}\tools\runtime"; Flags: ignoreversion
Source: "..\src\runtime\CodexBot-Watchdog.ps1"; DestDir: "{app}\tools\runtime"; Flags: ignoreversion
Source: "..\src\runtime\CodexBot-Hidden-Runner.vbs"; DestDir: "{app}\tools\runtime"; Flags: ignoreversion
Source: "..\src\runtime\Local-Service-Identity.ps1"; DestDir: "{app}\tools\runtime"; Flags: ignoreversion
Source: "..\src\runtime\Enable-Always-On.ps1"; DestDir: "{app}\tools\runtime"; Flags: ignoreversion
Source: "..\src\runtime\Disable-Always-On.ps1"; DestDir: "{app}\tools\runtime"; Flags: ignoreversion
Source: "..\scripts\patch-app.cjs"; DestDir: "{app}\tools\scripts"; Flags: ignoreversion
Source: "..\scripts\brand-executable.cjs"; DestDir: "{app}\tools\scripts"; Flags: ignoreversion
Source: "..\scripts\Install-CodexBot.ps1"; DestDir: "{app}\tools\scripts"; Flags: ignoreversion
Source: "..\scripts\Verify-GrokBotInstaller.ps1"; DestDir: "{app}\tools\integrity"; Flags: ignoreversion
Source: "..\scripts\Verify-GrokBotInstaller.ps1"; Flags: dontcopy
Source: "..\scripts\Verify-GrokBotRuntime.ps1"; DestDir: "{app}\tools\integrity"; Flags: ignoreversion
Source: "..\scripts\Verify-GrokBotRuntime.ps1"; Flags: dontcopy
Source: "..\assets\grok-bot-0.18.0-windows-x64.manifest.json"; DestDir: "{app}\tools\integrity"; Flags: ignoreversion
Source: "..\assets\grok-bot-0.18.0-windows-x64.manifest.json"; Flags: dontcopy
Source: "..\assets\codex-bot.ico"; DestDir: "{app}\tools\assets"; Flags: ignoreversion
Source: "..\node_modules\*"; DestDir: "{app}\tools\node_modules"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\build\vendor\cliproxyapi\cli-proxy-api.exe"; DestDir: "{app}\tools\cliproxyapi"; Flags: ignoreversion
Source: "..\build\vendor\cliproxyapi\LICENSE"; DestDir: "{app}\licenses"; DestName: "CLIProxyAPI-LICENSE.txt"; Flags: ignoreversion
Source: "..\LICENSE"; DestDir: "{app}\licenses"; DestName: "CodexBotBridge-LICENSE.txt"; Flags: ignoreversion
Source: "..\NOTICE.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "{code:GetVendorRoot}\*"; DestDir: "{app}\app"; ExternalSize: 496010226; Flags: external ignoreversion recursesubdirs createallsubdirs

[InstallDelete]
Type: files; Name: "{app}\app\Codex Bot.exe"
Type: files; Name: "{app}\app\resources\app.codex.asar"
Type: filesandordirs; Name: "{app}\app\resources\app.codex.asar.unpacked"

[Icons]
Name: "{autoprograms}\Codex Bot"; Filename: "{sys}\wscript.exe"; Parameters: "//B //NoLogo ""{app}\tools\runtime\CodexBot-Hidden-Runner.vbs"" launcher"; WorkingDir: "{app}"
Name: "{autodesktop}\Codex Bot"; Filename: "{sys}\wscript.exe"; Parameters: "//B //NoLogo ""{app}\tools\runtime\CodexBot-Hidden-Runner.vbs"" launcher"; WorkingDir: "{app}"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"; Flags: checkedonce

[Run]
Filename: "{sys}\wscript.exe"; Parameters: "//B //NoLogo ""{app}\tools\runtime\CodexBot-Hidden-Runner.vbs"" launcher"; Description: "Launch Codex Bot"; Flags: nowait postinstall skipifsilent runhidden

[UninstallRun]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""{app}\tools\runtime\Disable-Always-On.ps1"""; Flags: runhidden waituntilterminated; RunOnceId: "DisableCodexBotBridge"

[UninstallDelete]
Type: files; Name: "{app}\app\Codex Bot.exe"

[Code]
var
  VendorChoicePage: TInputOptionWizardPage;
  DownloadPage: TDownloadWizardPage;
  VendorProgressPage: TOutputMarqueeProgressWizardPage;
  InstallExitCode: Integer;
  RemoveUserDataOnUninstall: Boolean;
  IntegrityFilesExtracted: Boolean;
  VendorPrepared: Boolean;
  VendorInstalledBySetup: Boolean;
  VerifiedVendorRoot: String;
  RequestedVendorRoot: String;
  LastVendorError: String;
  VendorDownloadPolicyError: String;

const
  VendorUninstallKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall';
  VendorDisplayName = 'Grok Bot 0.18.0';

function GetVendorRoot(Param: String): String;
begin
  Result := VerifiedVendorRoot;
end;

function GetVendorInstallerSizeBytes: Int64;
begin
  Result := {#VendorInstallerSize};
end;

function OnVendorDownloadProgress(const Url, Filename: String;
  const Progress, ProgressMax: Int64): Boolean;
begin
  Result := False;
  if Progress < 0 then
  begin
    VendorDownloadPolicyError := 'The official Grok Bot download reported an invalid byte count and was stopped before verification.';
    Exit;
  end;
  if (ProgressMax > 0) and
     (ProgressMax <> GetVendorInstallerSizeBytes) then
  begin
    VendorDownloadPolicyError := 'The official Grok Bot download size did not match the pinned {#VendorInstallerSize}-byte installer and was stopped before verification.';
    Exit;
  end;
  if Progress > GetVendorInstallerSizeBytes then
  begin
    VendorDownloadPolicyError := 'The official Grok Bot download exceeded the pinned {#VendorInstallerSize}-byte limit and was stopped before verification.';
    Exit;
  end;
  Result := True;
end;

procedure InitializeWizard;
begin
  InstallExitCode := 0;
  RequestedVendorRoot := Trim(ExpandConstant('{param:GROKBOTDIR|}'));
  VendorChoicePage := CreateInputOptionPage(
    wpSelectDir,
    'Grok Bot frontend',
    'Choose how Setup obtains the required third-party frontend.',
    'Setup always reuses an exact Grok Bot 0.18.0 installation when one is available and never modifies it. Otherwise you can authorize Setup to download the exact separate 120 MiB per-user installer directly from downloads.cursor.com, verify its pinned SHA-256 and Anysphere signature, and install it as a separate vendor app. That app remains installed if Codex Bot Setup fails, is canceled, or Codex Bot is later uninstalled. Cursor Terms of Service and Privacy Policy apply: https://cursor.com/terms-of-service and https://cursor.com/privacy.',
    True,
    False
  );
  VendorChoicePage.Add('I authorize Setup to download and silently install the separate, pinned 120 MiB official Grok Bot 0.18.0 user app from downloads.cursor.com if no exact installed copy is found.');
  VendorChoicePage.Add('Never download or install it; continue only with an exact existing Grok Bot 0.18.0 installation.');
  VendorChoicePage.SelectedValueIndex := -1;

  DownloadPage := CreateDownloadPage(
    'Downloading official Grok Bot 0.18.0',
    'The vendor installer is downloaded directly from downloads.cursor.com and is not contained in Codex Bot.',
    @OnVendorDownloadProgress
  );
  DownloadPage.ShowBaseNameInsteadOfUrl := True;
  VendorProgressPage := CreateOutputMarqueeProgressPage(
    'Preparing Grok Bot 0.18.0',
    'Verifying and installing the separate vendor application.'
  );
end;

procedure EnsureIntegrityFilesExtracted;
begin
  if IntegrityFilesExtracted then
    Exit;
  ExtractTemporaryFile('Verify-GrokBotInstaller.ps1');
  ExtractTemporaryFile('Verify-GrokBotRuntime.ps1');
  ExtractTemporaryFile('grok-bot-0.18.0-windows-x64.manifest.json');
  IntegrityFilesExtracted := True;
end;

function NormalizeCandidate(Value: String): String;
begin
  Value := Trim(Value);
  if (Value = '') or (Pos('"', Value) > 0) or (Pos('\\', Value) = 1) then
  begin
    Result := '';
    Exit;
  end;
  Result := RemoveBackslashUnlessRoot(ExpandFileName(Value));
end;

function CandidateFromCommandLine(Value: String): String;
var
  QuoteAt: Integer;
  SpaceAt: Integer;
  ExecutablePath: String;
begin
  Result := '';
  Value := Trim(Value);
  if Value = '' then
    Exit;
  if Value[1] = '"' then
  begin
    Delete(Value, 1, 1);
    QuoteAt := Pos('"', Value);
    if QuoteAt = 0 then
      Exit;
    ExecutablePath := Copy(Value, 1, QuoteAt - 1);
  end
  else
  begin
    SpaceAt := Pos(' ', Value);
    if SpaceAt = 0 then
      ExecutablePath := Value
    else
      ExecutablePath := Copy(Value, 1, SpaceAt - 1);
  end;
  Result := NormalizeCandidate(ExtractFileDir(ExecutablePath));
end;

function VerifyVendorCandidate(Candidate: String): Boolean;
var
  ResultCode: Integer;
  Parameters: String;
begin
  Result := False;
  Candidate := NormalizeCandidate(Candidate);
  if (Candidate = '') or (not DirExists(Candidate)) then
    Exit;
  Parameters := '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' +
    ExpandConstant('{tmp}\Verify-GrokBotRuntime.ps1') + '" -InstallRoot "' + Candidate +
    '" -ManifestPath "' + ExpandConstant('{tmp}\grok-bot-0.18.0-windows-x64.manifest.json') + '"';
  if Exec(
    ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    Parameters,
    ExpandConstant('{tmp}'),
    SW_HIDE,
    ewWaitUntilTerminated,
    ResultCode
  ) and (ResultCode = 0) then
  begin
    VerifiedVendorRoot := Candidate;
    Result := True;
  end;
end;

function RegistryCandidate(RootKey: Integer; Subkey: String): String;
var
  InstallLocation: String;
  UninstallString: String;
  DisplayIcon: String;
  CommaAt: Integer;
begin
  Result := '';
  if RegQueryStringValue(RootKey, Subkey, 'InstallLocation', InstallLocation) and
     (NormalizeCandidate(InstallLocation) <> '') then
  begin
    Result := NormalizeCandidate(InstallLocation);
    Exit;
  end;
  if RegQueryStringValue(RootKey, Subkey, 'UninstallString', UninstallString) then
  begin
    Result := CandidateFromCommandLine(UninstallString);
    if Result <> '' then
      Exit;
  end;
  if RegQueryStringValue(RootKey, Subkey, 'DisplayIcon', DisplayIcon) then
  begin
    CommaAt := Pos(',', DisplayIcon);
    if CommaAt > 0 then
      DisplayIcon := Copy(DisplayIcon, 1, CommaAt - 1);
    Result := CandidateFromCommandLine(DisplayIcon);
  end;
end;

function FindVendorInRegistry(RootKey: Integer): Boolean;
var
  Names: TArrayOfString;
  Index: Integer;
  Subkey: String;
  DisplayName: String;
  DisplayVersion: String;
begin
  Result := False;
  if not RegGetSubkeyNames(RootKey, VendorUninstallKey, Names) then
    Exit;
  for Index := 0 to GetArrayLength(Names) - 1 do
  begin
    Subkey := VendorUninstallKey + '\' + Names[Index];
    DisplayName := '';
    DisplayVersion := '';
    RegQueryStringValue(RootKey, Subkey, 'DisplayName', DisplayName);
    RegQueryStringValue(RootKey, Subkey, 'DisplayVersion', DisplayVersion);
    if ((CompareText(Trim(DisplayName), VendorDisplayName) = 0) or
        ((Pos('GROK BOT', Uppercase(Trim(DisplayName))) = 1) and
         (CompareText(Trim(DisplayVersion), '{#VendorVersion}') = 0))) and
       VerifyVendorCandidate(RegistryCandidate(RootKey, Subkey)) then
    begin
      Result := True;
      Exit;
    end;
  end;
end;

function HasPerUserVendorInRegistry(RootKey: Integer): Boolean;
var
  Names: TArrayOfString;
  Index: Integer;
  Subkey: String;
  DisplayName: String;
begin
  Result := False;
  if not RegGetSubkeyNames(RootKey, VendorUninstallKey, Names) then
    Exit;
  for Index := 0 to GetArrayLength(Names) - 1 do
  begin
    Subkey := VendorUninstallKey + '\' + Names[Index];
    DisplayName := '';
    RegQueryStringValue(RootKey, Subkey, 'DisplayName', DisplayName);
    if Pos('GROK BOT', Uppercase(Trim(DisplayName))) = 1 then
    begin
      Result := True;
      Exit;
    end;
  end;
end;

function HasConflictingPerUserVendor: Boolean;
begin
  Result := HasPerUserVendorInRegistry(HKCU64) or
    HasPerUserVendorInRegistry(HKCU32) or
    DirExists(ExpandConstant('{localappdata}\Programs\Grok Bot')) or
    DirExists(ExpandConstant('{localappdata}\Programs\grok-bot'));
end;

function FindExactVendorRoot: Boolean;
begin
  Result := False;
  EnsureIntegrityFilesExtracted;
  if RequestedVendorRoot <> '' then
  begin
    Result := VerifyVendorCandidate(RequestedVendorRoot);
    if not Result then
      LastVendorError := 'The /GROKBOTDIR folder is not the exact supported, signed Grok Bot 0.18.0 Windows x64 installation.';
    Exit;
  end;

  if FindVendorInRegistry(HKCU64) then
  begin
    Result := True;
    Exit;
  end;
  if FindVendorInRegistry(HKCU32) then
  begin
    Result := True;
    Exit;
  end;
  if FindVendorInRegistry(HKLM64) then
  begin
    Result := True;
    Exit;
  end;
  if FindVendorInRegistry(HKLM32) then
  begin
    Result := True;
    Exit;
  end;
  if VerifyVendorCandidate(ExpandConstant('{localappdata}\Programs\Grok Bot')) then
  begin
    Result := True;
    Exit;
  end;
  if VerifyVendorCandidate(ExpandConstant('{localappdata}\Programs\grok-bot')) then
  begin
    Result := True;
    Exit;
  end;
  Result := VerifyVendorCandidate(ExpandConstant('{commonpf}\Grok Bot'));
end;

function BootstrapAllowed: Boolean;
begin
  if WizardSilent then
    Result := CompareText(Trim(ExpandConstant('{param:BOOTSTRAPGROKBOT|0}')), '1') = 0
  else
    Result := VendorChoicePage.SelectedValueIndex = 0;
end;

function DownloadAndVerifyVendorInstaller: Boolean;
var
  ResultCode: Integer;
  Parameters: String;
  DownloadedBytes: Int64;
begin
  Result := False;
  VendorDownloadPolicyError := '';
  DownloadedBytes := -1;
  DownloadPage.Clear;
  DownloadPage.Add(
    '{#VendorInstallerURL}',
    '{#VendorInstallerName}',
    Lowercase('{#VendorInstallerSHA256}')
  );
  if not WizardSilent then
    DownloadPage.Show;
  try
    try
      DownloadedBytes := DownloadPage.Download;
    except
      if DownloadPage.AbortedByUser then
        LastVendorError := 'The official Grok Bot download was canceled.'
      else if VendorDownloadPolicyError <> '' then
        LastVendorError := VendorDownloadPolicyError
      else
        LastVendorError := 'The official Grok Bot download failed: ' + GetExceptionMessage;
      Exit;
    end;
  finally
    if not WizardSilent then
      DownloadPage.Hide;
  end;

  if DownloadedBytes <> GetVendorInstallerSizeBytes then
  begin
    LastVendorError := 'The official Grok Bot download returned a byte count that did not match the pinned {#VendorInstallerSize}-byte installer and was stopped before verification.';
    Exit;
  end;

  Parameters := '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' +
    ExpandConstant('{tmp}\Verify-GrokBotInstaller.ps1') + '" -InstallerPath "' +
    ExpandConstant('{tmp}\{#VendorInstallerName}') + '"';
  if not Exec(
    ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    Parameters,
    ExpandConstant('{tmp}'),
    SW_HIDE,
    ewWaitUntilTerminated,
    ResultCode
  ) then
  begin
    LastVendorError := 'Could not start the pinned Grok Bot installer integrity check.';
    Exit;
  end;
  if ResultCode <> 0 then
  begin
    LastVendorError := 'The downloaded Grok Bot installer failed its pinned size, SHA-256, version, or Authenticode signer check and was not executed.';
    Exit;
  end;
  Result := True;
end;

function InstallVendorDependency: Boolean;
var
  ResultCode: Integer;
begin
  Result := False;
  if HasConflictingPerUserVendor then
  begin
    LastVendorError := 'A per-user Grok Bot installation or install folder is already present, but it is not the exact supported 0.18.0 tree. Setup will not repair, overwrite, update, or downgrade it. Manage that separate app yourself, then rerun Setup with an exact 0.18.0 tree or /GROKBOTDIR="folder".';
    Exit;
  end;

  if not WizardSilent then
  begin
    VendorProgressPage.SetText(
      'Installing the verified official Grok Bot 0.18.0 user app...',
      'This separate vendor application remains installed if Codex Bot Setup is later canceled or fails.'
    );
    VendorProgressPage.Show;
    VendorProgressPage.Animate;
  end;
  try
    if not ExecAsOriginalUser(
      ExpandConstant('{tmp}\{#VendorInstallerName}'),
      '/S /currentuser',
      ExpandConstant('{tmp}'),
      SW_HIDE,
      ewWaitUntilTerminated,
      ResultCode
    ) then
    begin
      LastVendorError := 'Could not start the verified official Grok Bot 0.18.0 user installer.';
      Exit;
    end;
  finally
    if not WizardSilent then
      VendorProgressPage.Hide;
  end;
  if ResultCode <> 0 then
  begin
    LastVendorError := Format('The official Grok Bot 0.18.0 user installer failed (exit code %d). Any separate vendor files it created are not managed or removed by Codex Bot Setup.', [ResultCode]);
    Exit;
  end;
  VendorInstalledBySetup := True;
  Result := True;
end;

function PrepareVendorDependency: Boolean;
begin
  Result := False;
  LastVendorError := '';
  if VendorPrepared then
  begin
    Result := True;
    Exit;
  end;
  if FindExactVendorRoot then
  begin
    VendorPrepared := True;
    Result := True;
    Exit;
  end;
  if RequestedVendorRoot <> '' then
    Exit;
  if not BootstrapAllowed then
  begin
    LastVendorError := 'No exact Grok Bot 0.18.0 installation was found and downloading it was not authorized. Interactive Setup can authorize the vendor-hosted download; silent Setup requires /BOOTSTRAPGROKBOT=1.';
    Exit;
  end;
  if HasConflictingPerUserVendor then
  begin
    LastVendorError := 'A per-user Grok Bot installation or install folder is already present, but it is not the exact supported 0.18.0 tree. Setup will not repair, overwrite, update, or downgrade it. Manage that separate app yourself, then rerun Setup with an exact 0.18.0 tree or /GROKBOTDIR="folder".';
    Exit;
  end;
  if not DownloadAndVerifyVendorInstaller then
    Exit;
  if not InstallVendorDependency then
    Exit;
  if not FindExactVendorRoot then
  begin
    LastVendorError := 'The separate Grok Bot installer returned success, but Setup could not locate and fully verify the exact 0.18.0 installed tree. The separate vendor installation was not rolled back.';
    Exit;
  end;
  VendorPrepared := True;
  Result := True;
end;

procedure InvalidateInteractiveVendorChoiceCache;
begin
  VendorPrepared := False;
  VerifiedVendorRoot := '';
end;

function PrepareVendorDependencyAndRecordExitCode: Boolean;
begin
  Result := PrepareVendorDependency;
  if Result then
    InstallExitCode := 0
  else
    InstallExitCode := 7;
end;

function GetCustomSetupExitCode: Integer;
begin
  Result := InstallExitCode;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  if not PrepareVendorDependencyAndRecordExitCode then
    Result := LastVendorError;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  ExactVendorFound: Boolean;
begin
  Result := True;
  if (CurPageID = VendorChoicePage.ID) and (not WizardSilent) then
  begin
    InvalidateInteractiveVendorChoiceCache;
    if VendorChoicePage.SelectedValueIndex < 0 then
    begin
      LastVendorError := 'Choose whether Setup may download and install the separate vendor app. Nothing will be downloaded until you deliberately select the authorization option.';
      SuppressibleMsgBox(LastVendorError, mbError, MB_OK, IDOK);
      Result := False;
      Exit;
    end;
    if VendorChoicePage.SelectedValueIndex = 1 then
    begin
      LastVendorError := '';
      VendorProgressPage.SetText(
        'Checking the installed Grok Bot 0.18.0 app...',
        'Setup is verifying the complete installed vendor application. No download will occur.'
      );
      VendorProgressPage.Show;
      VendorProgressPage.Animate;
      try
        ExactVendorFound := FindExactVendorRoot;
      finally
        VendorProgressPage.Hide;
      end;
      if not ExactVendorFound then
      begin
        if LastVendorError = '' then
        begin
          if HasConflictingPerUserVendor then
            LastVendorError := 'A per-user Grok Bot installation or install folder is present, but it is not the exact supported 0.18.0 tree. Setup will not repair, overwrite, update, or downgrade it. Manage that separate app yourself, then rerun Setup.'
          else
            LastVendorError := 'Setup did not find an exact, signed Grok Bot 0.18.0 installation. Select the download authorization option to let this one Setup obtain it securely, or cancel Setup and install an exact copy yourself.';
        end;
        SuppressibleMsgBox(LastVendorError, mbError, MB_OK, IDOK);
        Result := False;
        Exit;
      end;
      VendorPrepared := True;
    end;
  end;
  if (CurPageID = wpReady) and (not WizardSilent) then
  begin
    Result := PrepareVendorDependencyAndRecordExitCode;
    if not Result then
      SuppressibleMsgBox(LastVendorError, mbCriticalError, MB_OK, IDOK);
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
  Parameters: String;
begin
  if CurStep = ssPostInstall then
  begin
    Parameters := '-NoProfile -ExecutionPolicy Bypass -File "' +
      ExpandConstant('{app}\tools\scripts\Install-CodexBot.ps1') +
      '" -InstallRoot "' + ExpandConstant('{app}') + '"';
    if not Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), Parameters, ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    begin
      InstallExitCode := 1;
      RaiseException('Could not start the Codex Bot installation step.');
    end;
    if ResultCode <> 0 then
    begin
      InstallExitCode := ResultCode;
      if VendorInstalledBySetup then
        RaiseException(Format('Codex Bot patching failed (exit code %d). The separately installed official Grok Bot app remains installed and is not rolled back by Codex Bot Setup.', [ResultCode]))
      else
        RaiseException(Format('Codex Bot patching failed (exit code %d). The separate Grok Bot installation was not changed.', [ResultCode]));
    end;
  end;
end;

function InitializeUninstall(): Boolean;
begin
  Result := True;
  RemoveUserDataOnUninstall := False;
  if not UninstallSilent then
    RemoveUserDataOnUninstall := MsgBox(
      'Also permanently delete Codex Bot conversations, account sign-ins, browser profiles, downloads, and local settings?' + #13#10 + #13#10 +
      'Choose No to keep that data for a future reinstall.',
      mbConfirmation,
      MB_YESNO
    ) = IDYES;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  StateRoot: String;
  LocalAppDataRoot: String;
begin
  if (CurUninstallStep = usPostUninstall) and RemoveUserDataOnUninstall then
  begin
    StateRoot := AddBackslash(ExpandConstant('{localappdata}\Codex Bot Bridge'));
    LocalAppDataRoot := AddBackslash(ExpandConstant('{localappdata}'));
    if Pos(Uppercase(LocalAppDataRoot), Uppercase(StateRoot)) = 1 then
    begin
      if (not DelTree(StateRoot, True, True, True)) or DirExists(StateRoot) then
        MsgBox(
          'Codex Bot was uninstalled, but Windows could not delete all local conversations, account sign-ins, browser profiles, downloads, and settings.' + #13#10 + #13#10 +
          'Close programs using this folder and delete it manually:' + #13#10 + StateRoot,
          mbError,
          MB_OK
        );
    end;
  end;
end;
