@echo off
setlocal
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul
if errorlevel 1 exit /b 1
cl /nologo /std:c++20 /EHsc /O2 /W3 /DUNICODE /D_UNICODE ^
   "%~dp0main.cpp" ^
   /Fe:"%~dp0..\..\resources\ca-capture.exe" ^
   /Fo:"%TEMP%\ca-capture.obj" ^
   /link d3d11.lib dxgi.lib windowsapp.lib mfplat.lib mfreadwrite.lib mfuuid.lib ole32.lib user32.lib
exit /b %errorlevel%
