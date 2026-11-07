Import("env")
import subprocess

BUDGET = {"main": 38000, "loader": 32000}


def check(source, target, env):
    elf = str(target[0])
    out = subprocess.run([env.subst("$SIZETOOL"), "-A", elf], capture_output=True, text=True).stdout
    used = 0
    for line in out.splitlines():
        cols = line.split()
        if len(cols) >= 2 and cols[0] in (".data", ".rodata", ".bss"):
            used += int(cols[1])
    name = env["PIOENV"]
    limit = BUDGET.get(name)
    print(f"static RAM [{name}]: {used} bytes (budget {limit})")
    if limit is not None and used > limit:
        print(f"ERROR: static RAM {used} > budget {limit} for [{name}]. Move text to PROGMEM/F() or raise the budget in tools/ram_budget.py on purpose.")
        env.Exit(1)


env.AddPostAction("$BUILD_DIR/${PROGNAME}.elf", check)
