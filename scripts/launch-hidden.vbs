' 054 隐藏启动器：用窗口样式 0 启动目标，进程创建时就不分配可见控制台，
' Windows Terminal 的控制台交接（计划任务「黑框」的来源）无从发生。
'
' 用法：wscript.exe //nologo launch-hidden.vbs "<node.exe>" "<script.mjs>" [更多参数...]
'
' 两个设计点：
' 1. 第三参 True = 等目标退出再退。计划任务「停止」只会杀 wscript 这一层，
'    守卫靠 parentVanished 发现父进程没了，自己带着整棵树收工——语义跟以前一致。
' 2. 本文件装在仓库外（%LOCALAPPDATA%\ai-workbench\），仓库里只留模板；
'    由 scripts/install-launcher.mjs 负责复制与改任务动作，重复跑安全。
'
' 注意：VBScript 是微软宣布弃用的组件，未来 Windows 移除它时，
' 改用「不管用户是否登录都运行」（LogonType=Password，session 0 没有窗口）——见 054。

Option Explicit
If WScript.Arguments.Count < 2 Then WScript.Quit 2

Dim sh, cmd, i
cmd = """" & WScript.Arguments(0) & """"
For i = 1 To WScript.Arguments.Count - 1
  cmd = cmd & " """ & WScript.Arguments(i) & """"
Next

Set sh = CreateObject("WScript.Shell")
WScript.Quit sh.Run(cmd, 0, True)
