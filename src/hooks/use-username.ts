import { nanoid } from "nanoid"
import { useEffect, useState } from "react"

const animals = ["lion", "tiger", "wolf", "hawk", "bear", "eagle"];
const storage_key = "char_username";

const generateUsername = () => {
  const word = animals[Math.floor(Math.random() * animals.length)]
  return `anonymous-${word}-${nanoid(5)}`
}

export const useUsername = () => {
  const [username, setUsername] = useState("")

  useEffect(() => {
    const main = () => {
      const stored = localStorage.getItem(storage_key)

      if (stored) {
        setUsername(stored)
        return
      }

      const generated = generateUsername()
      localStorage.setItem(storage_key, generated)
      setUsername(generated)
    }

    main()
  }, [])

  return { username }
}