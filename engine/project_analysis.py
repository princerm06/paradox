import ast
import configparser
import errno
import os
from pathlib import Path, PurePosixPath
import re
import stat
from typing import Sequence


SCHEMA = 'paradox.project-analysis/v1'
ADAPTER = 'fastapi-sqlite-v1'
MAX_FILES = 4096
MAX_FILE_BYTES = 256 * 1024
MAX_TOTAL_BYTES = 4 * 1024 * 1024
MAX_AST_NODES = 50000
MAX_STATE_STEPS = 10000
IGNORED = {'.git', '.venv', 'venv', 'node_modules', '__pycache__', 'build', 'dist', '.tox', '.mypy_cache', '.pytest_cache'}
HEALTH_PATHS = {'/health', '/healthz', '/api/health'}


def _diagnostic(result, code, severity, message, path=None):
    item = dict(code=code, severity=severity, message=message, path=path)
    if item not in result['diagnostics']:
        result['diagnostics'].append(item)


def _safe_path(value):
    if not isinstance(value, str) or not value or len(value) > 4096 or '\\' in value or '\x00' in value:
        return False
    parts = value.split('/')
    return not value.startswith('/') and all(part not in {'', '.', '..'} for part in parts)


class _FileLimit(Exception):
    pass


class _TotalLimit(Exception):
    pass


class _ChangedFile(Exception):
    pass


class _AnalysisLimit(Exception):
    pass


def _read(root, root_fd, relative, budget):
    resolved = (root / relative).resolve(strict=True)
    resolved.relative_to(root)
    descriptor = os.dup(root_fd)
    try:
        parts = relative.split('/')
        for part in parts[:-1]:
            incoming = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = incoming
        incoming = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=descriptor)
        try:
            metadata = os.fstat(incoming)
            if not stat.S_ISREG(metadata.st_mode):
                raise ValueError('not a regular file')
            if metadata.st_size > MAX_FILE_BYTES:
                raise _FileLimit()
            if metadata.st_size > budget['remaining']:
                raise _TotalLimit()
            chunks = []
            size = 0
            limit = min(MAX_FILE_BYTES, budget['remaining'])
            while size < limit:
                chunk = os.read(incoming, min(65536, limit - size))
                if not chunk:
                    break
                chunks.append(chunk)
                size += len(chunk)
                budget['remaining'] -= len(chunk)
            after = os.fstat(incoming)
            if (metadata.st_size, metadata.st_mtime_ns) != (after.st_size, after.st_mtime_ns) or size != after.st_size:
                raise _ChangedFile()
            return b''.join(chunks)
        finally:
            os.close(incoming)
    finally:
        os.close(descriptor)


def _literal(text):
    try:
        return ast.literal_eval(text)
    except (ValueError, SyntaxError, RecursionError):
        return None


def _requires_python(result, value, path):
    if isinstance(value, str) and len(value) <= 128 and re.fullmatch(r'[0-9.*+<>=!~^,| a-zA-Z-]+', value) and re.search(r'\d', value):
        existing = result['runtime']['python_requires']
        if existing is not None and existing != value:
            _diagnostic(result, 'python_requires_ambiguous', 'warning', 'Dependency manifests declare different Python requirements.', path)
        elif existing is None:
            result['runtime']['python_requires'] = value


def _is_fastapi(value):
    return isinstance(value, str) and re.match(r'^fastapi(?:\[.*?\])?(?:\s*(?:[<>=!~@;]|$))', value, re.I) is not None


def _manifest(result, path, kind, text):
    if kind == 'requirements':
        lines = [re.split(r'\s+#', line.strip(), maxsplit=1)[0] for line in text.splitlines()]
        if any(line.startswith(('-r ', '-r=', '--requirement', '-c ', '--constraint', '-e ')) for line in lines):
            _diagnostic(result, 'dependency_indirection', 'warning', 'Referenced requirements or editable dependencies need explicit review; nothing is installed or followed.', path)
        return any(_is_fastapi(line) for line in lines)
    if kind == 'setup_cfg':
        parser = configparser.ConfigParser(interpolation=None)
        try:
            parser.read_string(text)
            _requires_python(result, parser.get('options', 'python_requires', fallback=None), path)
            return any(_is_fastapi(line.strip()) for line in parser.get('options', 'install_requires', fallback='').splitlines())
        except configparser.Error:
            _diagnostic(result, 'manifest_malformed', 'error', 'Cannot statically parse the dependency manifest.', path)
            return False
    section = ''
    fastapi = False
    dependency_array_seen = False
    lines = text.splitlines()
    for index, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith('['):
            section = stripped
        if kind == 'pyproject' and section == '[project]':
            if re.match(r'^requires-python\s*=', stripped):
                _requires_python(result, _literal(stripped.split('=', 1)[1].strip()), path)
            if re.match(r'^dependencies\s*=', stripped):
                if dependency_array_seen:
                    _diagnostic(result, 'manifest_malformed', 'error', 'Duplicate project dependency declarations need explicit review.', path)
                    continue
                dependency_array_seen = True
                value = stripped.split('=', 1)[1].strip()
                parsed = _literal(value)
                if parsed is None and value.startswith('['):
                    continuation = []
                    for following in lines[index + 1:]:
                        if following.strip().startswith('['):
                            break
                        continuation.append(following)
                        if following.strip().startswith(']'):
                            break
                    value += '\n' + '\n'.join(continuation)
                    parsed = _literal(value)
                if isinstance(parsed, list) and all(isinstance(item, str) for item in parsed):
                    fastapi = fastapi or any(_is_fastapi(item) for item in parsed)
                else:
                    _diagnostic(result, 'manifest_details_unavailable', 'warning', 'Dependencies use TOML syntax outside the bounded static subset; configure and review them explicitly.', path)
        if section in {'[tool.poetry.dependencies]', '[packages]'}:
            if re.match(r'^[\'"]?fastapi[\'"]?\s*=', stripped, re.I):
                fastapi = True
            if re.match(r'^python\s*=', stripped):
                _requires_python(result, _literal(stripped.split('=', 1)[1].strip()), path)
    if kind == 'pyproject' and not fastapi:
        _diagnostic(result, 'manifest_details_unavailable', 'info', 'No FastAPI declaration was recognized in the supported static TOML subset.', path)
    return fastapi


def _qualified(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        parent = _qualified(node.value)
        return parent + '.' + node.attr if parent else ''
    return ''


def _module(path):
    parts = list(PurePosixPath(path).with_suffix('').parts)
    if parts[-1] == '__init__':
        parts.pop()
    return '.'.join(parts) if parts and all(part.isidentifier() for part in parts) else None


def _env_read(node, os_names, environ_names, getenv_names):
    if isinstance(node, ast.Call):
        function = _qualified(node.func)
        if function in getenv_names or function in {name + '.getenv' for name in os_names} or function in {name + '.get' for name in environ_names}:
            argument = node.args[0] if node.args else None
            if isinstance(argument, ast.Constant) and isinstance(argument.value, str) and re.fullmatch(r'[A-Z_][A-Z0-9_]{0,127}', argument.value):
                return argument.value
    if isinstance(node, ast.Subscript) and _qualified(node.value) in environ_names:
        argument = node.slice
        if isinstance(argument, ast.Constant) and isinstance(argument.value, str) and re.fullmatch(r'[A-Z_][A-Z0-9_]{0,127}', argument.value):
            return argument.value
    return None


def _python(result, path, text):
    try:
        tree = ast.parse(text, filename='<tracked source>')
    except (SyntaxError, ValueError, RecursionError):
        _diagnostic(result, 'python_parse_failed', 'error', 'Python source could not be parsed by the inspector; it was not imported or executed.', path)
        return
    for count, unused_node in enumerate(ast.walk(tree), 1):
        if count > MAX_AST_NODES:
            raise _AnalysisLimit()
    constructors = set()
    sqlite_names = set()
    os_names = set()
    environ_names = set()
    getenv_names = set()
    engine_names = set()
    bindings = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name == 'fastapi':
                    constructors.add((alias.asname or alias.name) + '.FastAPI')
                if alias.name in {'sqlite3', 'aiosqlite'}:
                    sqlite_names.add((alias.asname or alias.name) + '.connect')
                if alias.name == 'os':
                    os_names.add(alias.asname or alias.name)
                if alias.name == 'sqlalchemy':
                    engine_names.add((alias.asname or alias.name) + '.create_engine')
                if alias.name.split('.')[0] in {'psycopg', 'psycopg2', 'asyncpg', 'pymysql', 'redis', 'pymongo', 'motor'}:
                    _diagnostic(result, 'external_state_dependency', 'warning', 'An external state/service client needs explicit adapter review.', path)
        if isinstance(node, ast.ImportFrom):
            for alias in node.names:
                if node.module == 'fastapi' and alias.name == 'FastAPI':
                    constructors.add(alias.asname or alias.name)
                if node.module in {'sqlite3', 'aiosqlite'} and alias.name == 'connect':
                    sqlite_names.add(alias.asname or alias.name)
                if node.module == 'os' and alias.name == 'getenv':
                    getenv_names.add(alias.asname or alias.name)
                if node.module == 'os' and alias.name == 'environ':
                    environ_names.add(alias.asname or alias.name)
                if node.module in {'sqlalchemy', 'sqlalchemy.ext.asyncio'} and alias.name in {'create_engine', 'create_async_engine'}:
                    engine_names.add(alias.asname or alias.name)
            if (node.module or '').split('.')[0] in {'psycopg', 'psycopg2', 'asyncpg', 'pymysql', 'redis', 'pymongo', 'motor'}:
                _diagnostic(result, 'external_state_dependency', 'warning', 'An external state/service client needs explicit adapter review.', path)
        if isinstance(node, (ast.Assign, ast.AnnAssign)) and node.value is not None:
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            for target in targets:
                if isinstance(target, ast.Name):
                    bindings.setdefault(target.id, []).append(node.value)
    environ_names.update(name + '.environ' for name in os_names)
    if constructors:
        result['runtime']['framework'] = 'fastapi'
    module = _module(path)
    factories = set()
    for function in tree.body:
        if isinstance(function, (ast.FunctionDef, ast.AsyncFunctionDef)):
            local_apps = {target.id for statement in function.body if isinstance(statement, ast.Assign)
                          and isinstance(statement.value, ast.Call) and _qualified(statement.value.func) in constructors
                          for target in statement.targets if isinstance(target, ast.Name)}
            if any(isinstance(statement, ast.Return) and
                   (isinstance(statement.value, ast.Name) and statement.value.id in local_apps or
                    isinstance(statement.value, ast.Call) and _qualified(statement.value.func) in constructors)
                   for statement in function.body):
                factories.add(function.name)
    for node in tree.body:
        if isinstance(node, (ast.Assign, ast.AnnAssign)) and isinstance(node.value, ast.Call):
            function = _qualified(node.value.func)
            if module and function in constructors | factories:
                targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                for target in targets:
                    if isinstance(target, ast.Name):
                        result['candidates']['app'].append(dict(target=module + ':' + target.id, path=path,
                                                              evidence='FastAPI() assignment' if function in constructors else 'assignment from a local FastAPI-returning factory'))
    app_handles = set()
    for statement in ast.walk(tree):
        if isinstance(statement, (ast.Assign, ast.AnnAssign)) and isinstance(statement.value, ast.Call) and _qualified(statement.value.func) in constructors:
            targets = statement.targets if isinstance(statement, ast.Assign) else [statement.target]
            app_handles.update(target.id for target in targets if isinstance(target, ast.Name))
    for node in tree.body:
        if isinstance(node, ast.Assign) and isinstance(node.value, ast.Call) and _qualified(node.value.func) in factories:
            app_handles.update(target.id for target in node.targets if isinstance(target, ast.Name))
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            for decorator in node.decorator_list:
                if isinstance(decorator, ast.Call) and isinstance(decorator.func, ast.Attribute) and decorator.func.attr == 'get' and _qualified(decorator.func.value) in app_handles:
                    route = decorator.args[0] if decorator.args else next((item.value for item in decorator.keywords if item.arg == 'path'), None)
                    if isinstance(route, ast.Constant) and route.value in HEALTH_PATHS:
                        result['candidates']['health'].append(dict(path=route.value, source=path))
    functions = {node.name: node for node in ast.walk(tree) if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))}
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in functions:
            function = functions[node.func.id]
            for parameter, argument in zip(function.args.args, node.args):
                bindings.setdefault(parameter.arg, []).append(argument)

    steps = 0
    def state_info(node, seen=frozenset()):
        nonlocal steps
        steps += 1
        if steps > MAX_STATE_STEPS:
            raise _AnalysisLimit()
        environment = _env_read(node, os_names, environ_names, getenv_names)
        if environment:
            return {environment}, set()
        if isinstance(node, ast.Name):
            if node.id in seen:
                return set(), set()
            children = bindings.get(node.id, [])
            seen = seen | {node.id}
        else:
            children = list(ast.iter_child_nodes(node))
        environments, paths = set(), set()
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            value = node.value.removeprefix('sqlite:///')
            if value != ':memory:' and value.endswith(('.sqlite', '.sqlite3', '.db')) and _safe_path(value):
                paths.add(value)
        for child in children:
            child_envs, child_paths = state_info(child, seen)
            environments.update(child_envs)
            paths.update(child_paths)
        return environments, paths

    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and _qualified(node.func) in sqlite_names | engine_names:
            argument = node.args[0] if node.args else next((item.value for item in node.keywords if item.arg == 'database'), None)
            if _qualified(node.func) in engine_names:
                if argument is None or not any(isinstance(item, ast.Constant) and isinstance(item.value, str) and item.value.startswith('sqlite:') for item in ast.walk(argument)):
                    _diagnostic(result, 'state_backend_unresolved', 'warning', 'A SQLAlchemy state backend could not be identified as local SQLite.', path)
                    continue
            environments, paths = state_info(argument) if argument is not None else (set(), set())
            for environment in sorted(environments) or [None]:
                for database in sorted(paths) or [None]:
                    result['candidates']['state'].append(dict(kind='sqlite', path=database, env=environment))
            if environments:
                for environment in sorted(environments):
                    _diagnostic(result, 'state_env_observed', 'info', 'Static SQLite argument evidence reads env ' + environment + '; runtime isolation is not proven.', path)
            else:
                _diagnostic(result, 'sqlite_state_unconfigured', 'warning', 'SQLite state is hard-coded or its environment source cannot be resolved statically.', path)
    if sqlite_names and not any(isinstance(node, ast.Call) and _qualified(node.func) in sqlite_names for node in ast.walk(tree)):
        result['candidates']['state'].append(dict(kind='sqlite', path=None, env=None))
        _diagnostic(result, 'sqlite_state_unconfigured', 'warning', 'SQLite is imported but its state location could not be determined statically.', path)


def inspect_project(root: Path, files: Sequence[str]) -> dict:
    result = dict(schema=SCHEMA, status='unsupported', adapter=None,
                  runtime=dict(language=None, framework=None, python_requires=None), dependencies=[],
                  candidates=dict(app=[], tests=[], health=[], state=[]), diagnostics=[])
    if len(files) > MAX_FILES:
        _diagnostic(result, 'file_count_limit', 'error', 'Tracked-file count exceeds the static inspection limit; narrow the project before inspection.')
        return result
    relevant = []
    for relative in sorted(set(item for item in files if isinstance(item, str))):
        if not _safe_path(relative):
            _diagnostic(result, 'unsafe_tracked_path', 'error', 'An unsafe tracked path was skipped.')
            continue
        parts = PurePosixPath(relative).parts
        if any(part in IGNORED for part in parts):
            continue
        name = parts[-1]
        if name == 'pyproject.toml':
            kind = 'pyproject'
        elif re.fullmatch(r'requirements(?:[-_.].*)?\.txt', name):
            kind = 'requirements'
        elif name == 'setup.cfg':
            kind = 'setup_cfg'
        elif name == 'Pipfile':
            kind = 'pipfile'
        elif name == 'setup.py':
            kind = 'other'
        elif name.endswith('.py'):
            kind = 'python'
        else:
            continue
        relevant.append((relative, kind))
    if len(files) != len([item for item in files if isinstance(item, str)]):
        _diagnostic(result, 'unsafe_tracked_path', 'error', 'An unsafe tracked path was skipped.')
    try:
        root = Path(root).resolve(strict=True)
        descriptor = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    except (OSError, ValueError, RuntimeError):
        _diagnostic(result, 'project_unreadable', 'error', 'The registered project directory is unavailable.')
        return result
    declared = False
    budget = {'remaining': MAX_TOTAL_BYTES}
    try:
        for relative, kind in relevant:
            try:
                content = _read(root, descriptor, relative, budget)
            except _FileLimit:
                _diagnostic(result, 'file_size_limit', 'error', 'A tracked file exceeds the 256 KiB static inspection limit.', relative)
                continue
            except _TotalLimit:
                _diagnostic(result, 'total_size_limit', 'error', 'Static inspection reached its 4 MiB total read budget.')
                break
            except _ChangedFile:
                _diagnostic(result, 'file_changed_during_inspection', 'error', 'A tracked file changed or could not be read completely; retry static inspection.', relative)
                continue
            except (OSError, ValueError, RuntimeError) as error:
                code = 'unsafe_file' if isinstance(error, (ValueError, RuntimeError)) or getattr(error, 'errno', None) in {errno.ELOOP, errno.ENOTDIR} else 'file_unreadable'
                _diagnostic(result, code, 'error', 'A tracked file was skipped because it is unavailable, unsafe, or not a regular file.', relative)
                continue
            text = content.decode('utf-8', errors='replace')
            if '\ufffd' in text:
                _diagnostic(result, 'source_decode_replaced', 'warning', 'Invalid UTF-8 was replaced during static inspection.', relative)
            if kind != 'python':
                result['dependencies'].append(dict(path=relative, kind=kind))
                declared = _manifest(result, relative, kind, text) or declared
            if relative.endswith('.py'):
                result['runtime']['language'] = 'python'
                parts = PurePosixPath(relative).parts
                if 'tests' in parts[:-1] and (parts[-1].startswith('test_') or parts[-1].endswith('_test.py')):
                    result['candidates']['tests'].append(dict(path='/'.join(parts[:parts.index('tests') + 1])))
                elif parts[-1].startswith('test_') or parts[-1].endswith('_test.py'):
                    result['candidates']['tests'].append(dict(path=relative))
                if 'tests' not in parts[:-1] and not parts[-1].startswith('test_') and not parts[-1].endswith('_test.py'):
                    try:
                        _python(result, relative, text)
                    except RecursionError:
                        _diagnostic(result, 'python_parse_failed', 'error', 'Python source exceeded bounded static analysis depth; it was not executed.', relative)
                    except _AnalysisLimit:
                        _diagnostic(result, 'analysis_complexity_limit', 'error', 'Python source exceeded the static node or state-flow operation budget.', relative)
    finally:
        os.close(descriptor)
    if declared:
        result['runtime']['framework'] = 'fastapi'
    if result['runtime']['framework'] == 'fastapi' and result['runtime']['language'] == 'python':
        result['adapter'] = ADAPTER
        candidates = result['candidates']
        if not candidates['app']:
            _diagnostic(result, 'app_candidate_missing', 'error', 'No module-level FastAPI application assignment could be resolved statically.')
        elif len(candidates['app']) != 1:
            _diagnostic(result, 'app_candidates_ambiguous', 'warning', 'Multiple FastAPI application assignments need an explicit app selection.')
        if not declared:
            _diagnostic(result, 'fastapi_dependency_missing', 'error', 'FastAPI is used but no dependency declaration was recognized.')
        if not any(not item['path'].endswith('.py') for item in candidates['tests']):
            _diagnostic(result, 'tests_directory_missing', 'error', 'No tracked pytest test directory was found.')
        if not candidates['health']:
            _diagnostic(result, 'health_route_missing', 'error', 'No literal GET health route was recognized.')
        elif not any(item['path'] == '/health' for item in candidates['health']):
            _diagnostic(result, 'health_path_nonstandard', 'warning', 'Only a nonstandard health path was found; configure it explicitly.')
        blockers = [item for item in result['diagnostics'] if item['severity'] != 'info']
        result['status'] = 'requires_configuration' if blockers else 'supported'
    else:
        _diagnostic(result, 'project_type_unsupported', 'error', 'Only statically recognizable Python FastAPI projects are supported by this adapter.')
    for name, items in result['candidates'].items():
        result['candidates'][name] = sorted({_key(item): item for item in items}.values(), key=_key)
    result['dependencies'].sort(key=lambda item: item['path'])
    result['diagnostics'].sort(key=lambda item: (item['code'], item['path'] or '', item['message']))
    return result


def _key(value):
    return tuple((key, value[key] or '') for key in sorted(value))
