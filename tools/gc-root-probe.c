// A live owner pointer must be visible to a conservative C-stack collector.
// Scan in a host import so the observer cannot spill its own expected pointer
// into the native stack and accidentally make this test pass.
#include <emscripten.h>
#include <stdint.h>
#include <wasm_simd128.h>
#include <stdio.h>
#include <stdlib.h>
EM_JS(void, remember_root, (uintptr_t root), { Module.expectedRoot = root; });
EM_JS(uint64_t, box_root, (uintptr_t root), {
    Module.expectedRoot = root;
    return (0xfffffff1n << 32n) | BigInt(root);
});
EM_JS(int, scan_root, (), {
    const top = _emscripten_stack_get_current(), base = _emscripten_stack_get_base();
    for (let p = top; p < base; p += 4)
        if (HEAPU32[p >>> 2] === Module.expectedRoot) return 1;
    return 0;
});
EM_JS(double, box_root_double, (uintptr_t root), {
    Module.expectedRoot = root;
    const bits = new DataView(new ArrayBuffer(8));
    bits.setUint32(0, root, true); bits.setUint32(4, 1, true);
    return bits.getFloat64(0, true);
});
static __attribute__((noinline)) int holdDouble(unsigned seed) {
    union { double number; uint64_t bits; } boxed;
    boxed.number = box_root_double((uintptr_t)malloc(137));
    int found = scan_root();
    unsigned char* root = (void*)(uintptr_t)boxed.bits;
    root[0] = (unsigned char)seed;
    free(root);
    return found;
}
static __attribute__((noinline)) int hold32(unsigned seed) {
    unsigned char* root = malloc(37);
    if (!root) abort();
    root[0] = (unsigned char)seed;
    remember_root((uintptr_t)root);
    int found = scan_root();
    if (root[0] != (unsigned char)seed) abort();
    free(root);
    return found;
}
static __attribute__((noinline)) int hold64(unsigned seed) {
    uint64_t boxed = box_root((uintptr_t)malloc(73));
    int found = scan_root();
    unsigned char* root = (void*)(uintptr_t)boxed;
    root[0] = (unsigned char)seed;
    free(root);
    return found;
}
// The optimizer can also keep multiple packed cells in a SIMD local.
static uint32_t vectorInput[4], vectorOutput[4];
EM_JS(void, box_vector, (uintptr_t root, uintptr_t address), {
    Module.expectedRoot = root;
    HEAPU32.set([root, 0xfffffff1, 31, 47], address >>> 2);
});
EM_JS(void, forget_vector, (uintptr_t address), { HEAPU32.fill(0, address >>> 2, (address >>> 2) + 4); });
EM_JS(uintptr_t, unbox_vector, (uintptr_t address), { return HEAPU32[address >>> 2]; });
static __attribute__((noinline)) int holdVector(unsigned seed) {
    box_vector((uintptr_t)malloc(337), (uintptr_t)vectorInput);
    v128_t boxed = wasm_v128_load(vectorInput);
    forget_vector((uintptr_t)vectorInput);
    int found = scan_root();
    wasm_v128_store(vectorOutput, boxed);
    free((void*)unbox_vector((uintptr_t)vectorOutput));
    return found;
}
int main(int argc, char** argv) {
    // Each root kind runs in a fresh process: a previous spill must not leave
    // a stale pointer that accidentally roots a subsequently reused address.
    int kind = argc > 1 ? atoi(argv[1]) : 0;
    int found;
    switch (kind) {
    case 0: found = hold32((unsigned)argc); break;
    case 1: found = hold64((unsigned)argc); break;
    case 2: found = holdDouble((unsigned)argc); break;
    case 3: found = holdVector((unsigned)argc); break;
    default: abort();
    }
    printf("root_kind=%d visible=%d\n", kind, found);
    return found ? 0 : 1;
}
