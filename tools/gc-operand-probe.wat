(module
  (import "env" "root" (func $root (result i32)))
  (import "env" "collect" (func $collect (result i32)))
  (memory (export "memory") 2)
  (global $__stack_pointer (export "__stack_pointer") (mut i32) (i32.const 65536))
  (func $consume (param $object i32) (param $unused i32) (result i32)
    (local.get $object))
  ;; The first result stays on the operand stack while the second call collects.
  ;; No original local contains that result, so local-only liveness misses it.
  (func (export "run") (result i32)
    (call $consume (call $root) (call $collect)))
)
