import React from "react"
import { Text } from "react-native"
import { useNavigation } from "@react-navigation/native"
import { splitCardMentions } from "../lib/cardMention"
import { useStyles } from "../lib/styles"

/** Text with each "Card N" made tappable: opens that card's page directly. */
export default function CardMentions({ text }: { text: string }) {
  const navigation = useNavigation<any>()
  const styles = useStyles()
  return (
    <>
      {splitCardMentions(text).map((p, i) =>
        p.id === undefined ? (
          <React.Fragment key={i}>{p.text}</React.Fragment>
        ) : (
          <Text key={i} style={styles.mdLink} onPress={() => navigation.navigate("CardDetail", { id: p.id })}>{p.text}</Text>
        )
      )}
    </>
  )
}
