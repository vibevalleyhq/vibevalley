package protocol

import (
	"fmt"
	"testing"

	"vibevalley/internal/testkit"
	"vibevalley/pkg/x/ptr"
)

func TestTargets(t *testing.T) {
	testkit.Eq(t, TargetOf(Conversation{Kind: ConversationKindGeneral}, nil), "#田头")
	testkit.Eq(t, TargetOf(Conversation{Kind: ConversationKindChannel, Name: ptr.To("clock-in")}, nil), "#clock-in")
	testkit.Eq(t, TargetOf(Conversation{Kind: ConversationKindThread, Parent: ptr.To("m1"), ParentNumber: ptr.To[int64](4812)}, nil), "#田头:4812")
	testkit.Eq(t, TargetOf(Conversation{Kind: ConversationKindThread, Parent: ptr.To("m2"), ParentNumber: ptr.To[int64](9)}, ptr.To("clock-in")), "#clock-in:9")
}

func TestChannelsInTheChat(t *testing.T) {
	chat := WithConversation(nil, Conversation{ID: "c1", Kind: ConversationKindGeneral, Name: ptr.To("田头")})
	chat = WithConversation(&chat, Conversation{ID: "c5", Kind: ConversationKindChannel, Name: ptr.To("clock-in"), Project: ptr.To("clock")})
	chat = WithConversation(&chat, Conversation{ID: "c7", Kind: ConversationKindThread, Parent: ptr.To("m30"), ParentNumber: ptr.To[int64](30), Channel: ptr.To("c5")})
	testkit.Eq(t, *ChannelOf(&chat, ConversationOf(&chat, "c7")).Name, "clock-in")
	testkit.Eq(t, AddressOf(&chat, *ConversationOf(&chat, "c7")), "#clock-in:30")
	testkit.Eq(t, *ChannelOf(&chat, &Conversation{ID: "c9", Kind: ConversationKindThread, Parent: ptr.To("m3"), ParentNumber: ptr.To[int64](3)}).Name, "田头")
}

func TestTheChatKeepsTheGeneral(t *testing.T) {
	chat := WithConversation(nil, Conversation{ID: "c1", Kind: ConversationKindGeneral})
	for i := int64(2); i <= KeepConversations+5; i++ {
		chat = WithConversation(&chat, Conversation{ID: fmt.Sprintf("c%d", i), Kind: ConversationKindThread, Parent: ptr.To(fmt.Sprintf("m%d", i)),
			ParentNumber: ptr.To(i), Replies: 1, LastNumber: ptr.To(i), At: i})
	}
	testkit.Eq(t, len(chat.Conversations), KeepConversations)
	testkit.Eq(t, chat.Conversations[0].Kind, ConversationKindGeneral, "the general channel is never dropped")
	if ConversationOf(&chat, "c2") != nil {
		t.Error("the quietest thread went")
	}
}
