@echo off
setlocal
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul
if errorlevel 1 exit /b 1
cl /nologo /std:c++17 /EHsc /O2 /W3 /DUNICODE /D_UNICODE ^
   "%~dp0main.cpp" ^
   /Fe:"%~dp0..\..\resources\ca-audio-capture.exe" ^
   /Fo:"%TEMP%\ca-audio-capture.obj" ^
   /link ole32.lib mmdevapi.lib
exit /b %errorlevel%
