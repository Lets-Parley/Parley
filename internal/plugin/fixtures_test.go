package plugin

import (
	"github.com/tetratelabs/wabin/binary"
	"github.com/tetratelabs/wabin/leb128"
	"github.com/tetratelabs/wabin/wasm"
)

// Hostile guests, assembled here rather than checked in.
//
// A committed .wasm goes stale silently — the assertions move on, the binary
// does not, and nobody notices because WASM output is not reliably
// reproducible, so a byte-for-byte freshness check gets disabled the first
// time it flakes. Building each fixture from these few instructions on every
// run makes the freshness question disappear: what the assertions run against
// is what this file says, always.
//
// Each fixture does exactly one hostile thing, so that neutering the guard it
// provokes makes that fixture's own assertion fail rather than some other's.

const (
	opUnreachable = 0x00
	opLoop        = 0x03
	opBr          = 0x0c
	opEnd         = 0x0b
	opCall        = 0x10
	opDrop        = 0x1a
	opI32Const    = 0x41
	opI32Store    = 0x36
	opMemoryGrow  = 0x40

	blockTypeEmpty = 0x40
)

func i32Const(v int32) []byte {
	return append([]byte{opI32Const}, leb128.EncodeInt32(v)...)
}

// guestBuilder assembles one module. Imports come first in the function index
// space, so a guest's own function is at index len(imports).
type guestBuilder struct {
	types   []*wasm.FunctionType
	imports []*wasm.Import
	memory  *wasm.Memory
}

func (b *guestBuilder) importFunc(module, name string, params, results []wasm.ValueType) uint32 {
	b.types = append(b.types, &wasm.FunctionType{Params: params, Results: results})
	idx := uint32(len(b.imports))
	b.imports = append(b.imports, &wasm.Import{
		Type: wasm.ExternTypeFunc, Module: module, Name: name, DescFunc: uint32(len(b.types) - 1),
	})
	return idx
}

// build finishes the module with one exported "run" function returning i32,
// which is the shape Extism calls.
func (b *guestBuilder) build(body []byte) []byte {
	b.types = append(b.types, &wasm.FunctionType{Results: []wasm.ValueType{wasm.ValueTypeI32}})
	runType := uint32(len(b.types) - 1)
	m := &wasm.Module{
		TypeSection:     b.types,
		ImportSection:   b.imports,
		FunctionSection: []wasm.Index{runType},
		MemorySection:   b.memory,
		ExportSection: []*wasm.Export{{
			Type: wasm.ExternTypeFunc, Name: "run", Index: uint32(len(b.imports)),
		}},
		CodeSection: []*wasm.Code{{Body: body}},
	}
	return binary.EncodeModule(m)
}

// guestNoop returns success and touches nothing. It is the control: a fixture
// that asserts containment has to be told apart from a plugin that simply
// works.
func guestNoop() []byte {
	var b guestBuilder
	return b.build(append(i32Const(0), opEnd))
}

// guestHang never returns. The per-call timeout is the only thing that ends it.
func guestHang() []byte {
	var b guestBuilder
	return b.build([]byte{
		opLoop, blockTypeEmpty,
		opBr, 0x00,
		opEnd,
		opUnreachable,
		opEnd,
	})
}

// guestMemoryHog asks for far more memory than the cap allows and then writes
// where that memory would have been. Under the cap the growth fails and the
// write is out of bounds; without it the write lands and the guest returns
// cleanly, which is exactly the assertion that has to go red when the cap is
// removed.
func guestMemoryHog(growPages int32, writeAt int32) []byte {
	b := guestBuilder{memory: &wasm.Memory{Min: 1}}
	body := append([]byte{}, i32Const(growPages)...)
	body = append(body, opMemoryGrow, 0x00, opDrop)
	body = append(body, i32Const(writeAt)...)
	body = append(body, i32Const(1)...)
	body = append(body, opI32Store, 0x02, 0x00)
	body = append(body, i32Const(0)...)
	return b.build(append(body, opEnd))
}

// guestPanic traps immediately.
func guestPanic() []byte {
	var b guestBuilder
	return b.build([]byte{opUnreachable, opEnd})
}

// guestCallsHost hands the call's input straight to one host function and
// ignores whatever comes back, which is what a plugin trying its luck looks
// like: the refusal has to be the host's, not the guest's good manners.
func guestCallsHost(name string) []byte {
	var b guestBuilder
	inputOffset := b.importFunc("extism:host/env", "input_offset", nil, []wasm.ValueType{wasm.ValueTypeI64})
	hostFn := b.importFunc("extism:host/user", name,
		[]wasm.ValueType{wasm.ValueTypeI64}, []wasm.ValueType{wasm.ValueTypeI64})

	body := []byte{opCall, byte(inputOffset), opCall, byte(hostFn), opDrop}
	body = append(body, i32Const(0)...)
	return b.build(append(body, opEnd))
}
