@echo off
rem ---------------------------------------------------------------------------
rem Stand-in for the helper venv's python.exe in _tests/host.test.mjs.
rem Windows cannot execute a .mjs file directly, so this shim forwards the same
rem argv to the Node stub (see stub-python.mjs).
rem ---------------------------------------------------------------------------
node "%~dp0stub-python.mjs" %*
